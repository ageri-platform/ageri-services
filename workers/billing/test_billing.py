"""
tests/test_billing.py — Unit tests for BillingStore and PaddleWebhookHandler.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time

import pytest

from ageri.billing import BillingStore, PaddleWebhookHandler, PRICE_CREDITS


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_signature(secret: str, raw_body: bytes, ts: str | None = None) -> str:
    ts = ts or str(int(time.time()))
    signed = f"{ts}:{raw_body.decode()}"
    h1 = hmac.new(secret.encode(), signed.encode(), hashlib.sha256).hexdigest()
    return f"ts={ts};h1={h1}"


def _transaction_payload(transaction_id: str, price_id: str) -> bytes:
    return json.dumps({
        "event_type": "transaction.completed",
        "data": {
            "id": transaction_id,
            "items": [{"price": {"id": price_id}}],
        },
    }).encode()


def _subscription_payload(event_type: str, subscription_id: str, price_id: str = "") -> bytes:
    return json.dumps({
        "event_type": event_type,
        "data": {
            "id": subscription_id,
            "items": [{"price": {"id": price_id}}] if price_id else [],
        },
    }).encode()


# ---------------------------------------------------------------------------
# BillingStore
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path):
    return BillingStore(tmp_path / "billing.db")


class TestBillingStore:
    def test_initial_balance_is_zero(self, store):
        assert store.get_balance() == 0

    def test_add_credits(self, store):
        new_bal = store.add_credits(500, transaction_id="txn_001", price_id="pri_abc")
        assert new_bal == 500
        assert store.get_balance() == 500

    def test_add_credits_accumulates(self, store):
        store.add_credits(500, transaction_id="txn_001")
        store.add_credits(1100, transaction_id="txn_002")
        assert store.get_balance() == 1600

    def test_add_credits_idempotent(self, store):
        store.add_credits(500, transaction_id="txn_001")
        store.add_credits(500, transaction_id="txn_001")  # duplicate
        assert store.get_balance() == 500

    def test_deduct_credits(self, store):
        store.add_credits(1000, transaction_id="txn_001")
        new_bal = store.deduct_credits(300)
        assert new_bal == 700
        assert store.get_balance() == 700

    def test_deduct_credits_insufficient(self, store):
        store.add_credits(100, transaction_id="txn_001")
        with pytest.raises(ValueError, match="Insufficient credits"):
            store.deduct_credits(200)

    def test_auto_reload_off_by_default(self, store):
        info = store.get_billing_info()
        assert info["auto_reload"] is False
        assert info["subscription_id"] is None

    def test_set_auto_reload_on(self, store):
        store.set_auto_reload(True, price_id="pri_abc", subscription_id="sub_001")
        info = store.get_billing_info()
        assert info["auto_reload"] is True
        assert info["subscription_id"] == "sub_001"
        assert info["auto_reload_price"] == "pri_abc"

    def test_set_auto_reload_off_clears(self, store):
        store.set_auto_reload(True, price_id="pri_abc", subscription_id="sub_001")
        store.set_auto_reload(False, subscription_id="sub_001")
        info = store.get_billing_info()
        assert info["auto_reload"] is False

    def test_transaction_history(self, store):
        store.add_credits(500, transaction_id="txn_001", price_id="pri_5")
        store.add_credits(1100, transaction_id="txn_002", price_id="pri_10")
        history = store.get_transaction_history()
        assert len(history) == 2
        granted = {h["credits_granted"] for h in history}
        assert granted == {500, 1100}


# ---------------------------------------------------------------------------
# PaddleWebhookHandler
# ---------------------------------------------------------------------------


@pytest.fixture
def billing(tmp_path):
    return BillingStore(tmp_path / "billing.db")


@pytest.fixture
def secret():
    return "test_webhook_secret"


@pytest.fixture
def handler(billing, secret):
    return PaddleWebhookHandler(billing, secret)


class TestPaddleWebhookHandler:
    def test_valid_signature_accepted(self, handler, secret):
        price_id = "pri_01kny6pv7stafaphtvxmfjpdyn"  # $5 one-time
        body = _transaction_payload("txn_001", price_id)
        sig = _make_signature(secret, body)
        result = handler.handle(body, sig)
        assert result.ok
        assert result.status == 200

    def test_invalid_signature_rejected(self, handler):
        body = _transaction_payload("txn_001", "pri_01kny6pv7stafaphtvxmfjpdyn")
        result = handler.handle(body, "ts=123;h1=badhash")
        assert not result.ok
        assert result.status == 401

    def test_transaction_completed_grants_credits(self, handler, billing, secret):
        price_id = "pri_01kny6pv7stafaphtvxmfjpdyn"  # $5 → 500 credits
        body = _transaction_payload("txn_001", price_id)
        sig = _make_signature(secret, body)
        handler.handle(body, sig)
        assert billing.get_balance() == 500

    def test_transaction_completed_all_tiers(self, handler, billing, secret):
        for price_id, expected_credits in PRICE_CREDITS.items():
            # Use unique transaction_id per price
            body = _transaction_payload(f"txn_{price_id}", price_id)
            sig = _make_signature(secret, body)
            result = handler.handle(body, sig)
            assert result.ok

        # Total credits should be sum of all grants
        total = sum(PRICE_CREDITS.values())
        assert billing.get_balance() == total

    def test_transaction_completed_idempotent(self, handler, billing, secret):
        price_id = "pri_01kny6pv7stafaphtvxmfjpdyn"
        body = _transaction_payload("txn_001", price_id)
        sig = _make_signature(secret, body)
        handler.handle(body, sig)
        handler.handle(body, sig)  # duplicate
        assert billing.get_balance() == 500

    def test_unknown_price_id_no_credits(self, handler, billing, secret):
        body = _transaction_payload("txn_001", "pri_unknown")
        sig = _make_signature(secret, body)
        result = handler.handle(body, sig)
        assert result.ok  # webhook still 200
        assert billing.get_balance() == 0

    def test_subscription_activated_sets_auto_reload(self, handler, billing, secret):
        price_id = "pri_01kny9fsz6etk82eb4da8hsrtg"  # $5/mo
        body = _subscription_payload("subscription.activated", "sub_001", price_id)
        sig = _make_signature(secret, body)
        handler.handle(body, sig)
        info = billing.get_billing_info()
        assert info["auto_reload"] is True
        assert info["subscription_id"] == "sub_001"
        assert info["auto_reload_price"] == price_id

    def test_subscription_cancelled_clears_auto_reload(self, handler, billing, secret):
        # Activate first
        price_id = "pri_01kny9fsz6etk82eb4da8hsrtg"
        activate_body = _subscription_payload("subscription.activated", "sub_001", price_id)
        handler.handle(activate_body, _make_signature(secret, activate_body))

        # Cancel
        cancel_body = _subscription_payload("subscription.cancelled", "sub_001")
        handler.handle(cancel_body, _make_signature(secret, cancel_body))

        info = billing.get_billing_info()
        assert info["auto_reload"] is False

    def test_cancelled_does_not_remove_credits(self, handler, billing, secret):
        # Grant some credits
        billing.add_credits(500, transaction_id="txn_001")
        # Cancel subscription
        cancel_body = _subscription_payload("subscription.cancelled", "sub_001")
        handler.handle(cancel_body, _make_signature(secret, cancel_body))
        assert billing.get_balance() == 500

    def test_no_secret_skips_verification(self, billing):
        handler = PaddleWebhookHandler(billing, webhook_secret="")
        price_id = "pri_01kny6pv7stafaphtvxmfjpdyn"
        body = _transaction_payload("txn_001", price_id)
        result = handler.handle(body, "")  # no signature header
        assert result.ok
        assert billing.get_balance() == 500

    def test_invalid_json_returns_400(self, handler, secret):
        body = b"not json"
        sig = _make_signature(secret, body)
        result = handler.handle(body, sig)
        assert result.status == 400
