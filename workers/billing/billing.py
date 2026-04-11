"""
ageri/billing.py — Paddle billing: credit store + webhook handler.

Credit grant flow:
  1. User purchases a one-time top-up or subscribes to a monthly plan.
  2. Paddle sends transaction.completed to POST /webhook/paddle.
  3. PaddleWebhookHandler verifies HMAC, maps price_id → credits, calls
     BillingStore.add_credits() and logs the transaction (idempotent).

Subscription flow:
  subscription.activated  → store subscription_id, set auto_reload=True
  subscription.cancelled  → set auto_reload=False (credits already granted kept)
  transaction.completed   → grant credits (fires for both one-time and recurring)

Credit tiers (sandbox price IDs):
  One-time:     $5=500  $10=1100  $20=2400  $50=6500
  Subscription: $5=500  $10=1100  $20=2400  $50=6500
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Price → credits mapping (both sandbox and live IDs)
# ---------------------------------------------------------------------------

PRICE_CREDITS: dict[str, int] = {
    # Sandbox — one-time top-ups
    "pri_01kny6pv7stafaphtvxmfjpdyn": 500,
    "pri_01kny8d1fprev73ym1vekeef47": 1100,
    "pri_01kny8efztkrdvcj2k87eqbn4g": 2400,
    "pri_01kny8fazn1qq6ffqeh7b3gatj": 6500,
    # Sandbox — monthly subscriptions
    "pri_01kny9fsz6etk82eb4da8hsrtg": 500,
    "pri_01kny9greyj0pp8af6se1cv34g": 1100,
    "pri_01kny9jhwbjbgym8gtfn71cxab": 2400,
    "pri_01kny9kpkmytaxg9mx8arfdp6a": 6500,
}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS billing (
    user_id            TEXT PRIMARY KEY,
    credits            INTEGER NOT NULL DEFAULT 0,
    auto_reload        INTEGER NOT NULL DEFAULT 0,
    auto_reload_price  TEXT,
    subscription_id    TEXT,
    updated_at         TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS billing_transactions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               TEXT NOT NULL,
    paddle_transaction_id TEXT NOT NULL UNIQUE,
    price_id              TEXT,
    credits_granted       INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT DEFAULT (datetime('now'))
);
"""

_OWNER = "owner"  # single-user — all credits go to this account


# ---------------------------------------------------------------------------
# BillingStore
# ---------------------------------------------------------------------------


class BillingStore:
    """
    Thread-safe SQLite store for user credit balances and billing transactions.

    All writes are synchronous. The web layer calls these from async context
    via asyncio.to_thread().
    """

    def __init__(self, db_path: str | Path) -> None:
        self._db_path = str(db_path)
        self._lock = threading.Lock()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._lock, self._connect() as conn:
            conn.executescript(_SCHEMA)

    # ------------------------------------------------------------------
    # Balance
    # ------------------------------------------------------------------

    def get_balance(self, user_id: str = _OWNER) -> int:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT credits FROM billing WHERE user_id = ?", (user_id,)
            ).fetchone()
            return int(row["credits"]) if row else 0

    def add_credits(
        self,
        credits: int,
        transaction_id: str,
        price_id: str = "",
        user_id: str = _OWNER,
    ) -> int:
        """
        Add credits to user balance. Idempotent — duplicate transaction_id is
        a no-op. Returns the new balance.
        """
        with self._lock, self._connect() as conn:
            # Check if this transaction was already processed
            existing = conn.execute(
                "SELECT id FROM billing_transactions WHERE paddle_transaction_id = ?",
                (transaction_id,),
            ).fetchone()
            if existing:
                logger.info(
                    "billing: duplicate transaction_id=%r — skipping", transaction_id
                )
                row = conn.execute(
                    "SELECT credits FROM billing WHERE user_id = ?", (user_id,)
                ).fetchone()
                return int(row["credits"]) if row else 0

            # Upsert balance
            conn.execute(
                """
                INSERT INTO billing (user_id, credits, updated_at)
                VALUES (?, ?, datetime('now'))
                ON CONFLICT(user_id) DO UPDATE SET
                    credits    = credits + excluded.credits,
                    updated_at = datetime('now')
                """,
                (user_id, credits),
            )
            # Log transaction
            conn.execute(
                """
                INSERT INTO billing_transactions
                    (user_id, paddle_transaction_id, price_id, credits_granted)
                VALUES (?, ?, ?, ?)
                """,
                (user_id, transaction_id, price_id, credits),
            )
            row = conn.execute(
                "SELECT credits FROM billing WHERE user_id = ?", (user_id,)
            ).fetchone()
            new_balance = int(row["credits"]) if row else credits
            logger.info(
                "billing: +%d credits for transaction_id=%r → balance=%d",
                credits,
                transaction_id,
                new_balance,
            )
            return new_balance

    def deduct_credits(self, credits: int, user_id: str = _OWNER) -> int:
        """
        Deduct credits. Returns new balance. Raises ValueError if insufficient.
        """
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT credits FROM billing WHERE user_id = ?", (user_id,)
            ).fetchone()
            current = int(row["credits"]) if row else 0
            if current < credits:
                raise ValueError(
                    f"Insufficient credits: have {current}, need {credits}"
                )
            conn.execute(
                """
                UPDATE billing SET credits = credits - ?, updated_at = datetime('now')
                WHERE user_id = ?
                """,
                (credits, user_id),
            )
            return current - credits

    # ------------------------------------------------------------------
    # Auto-reload / subscription
    # ------------------------------------------------------------------

    def set_auto_reload(
        self,
        enabled: bool,
        price_id: str = "",
        subscription_id: str = "",
        user_id: str = _OWNER,
    ) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO billing (user_id, auto_reload, auto_reload_price, subscription_id, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(user_id) DO UPDATE SET
                    auto_reload       = excluded.auto_reload,
                    auto_reload_price = excluded.auto_reload_price,
                    subscription_id   = excluded.subscription_id,
                    updated_at        = datetime('now')
                """,
                (user_id, int(enabled), price_id or None, subscription_id or None),
            )
        logger.info(
            "billing: auto_reload=%s subscription_id=%r price_id=%r",
            enabled,
            subscription_id,
            price_id,
        )

    def get_billing_info(self, user_id: str = _OWNER) -> dict:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM billing WHERE user_id = ?", (user_id,)
            ).fetchone()
            if not row:
                return {
                    "credits": 0,
                    "auto_reload": False,
                    "auto_reload_price": None,
                    "subscription_id": None,
                }
            return {
                "credits": int(row["credits"]),
                "auto_reload": bool(row["auto_reload"]),
                "auto_reload_price": row["auto_reload_price"],
                "subscription_id": row["subscription_id"],
            }

    def get_transaction_history(
        self, user_id: str = _OWNER, limit: int = 20
    ) -> list[dict]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT paddle_transaction_id, price_id, credits_granted, created_at
                FROM billing_transactions
                WHERE user_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (user_id, limit),
            ).fetchall()
            return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# PaddleWebhookHandler
# ---------------------------------------------------------------------------


@dataclass
class WebhookResult:
    ok: bool
    status: int
    message: str


class PaddleWebhookHandler:
    """
    Verifies Paddle webhook signatures and routes events to BillingStore.

    Paddle signature format (header: Paddle-Signature):
      ts=<unix_timestamp>;h1=<hex_hmac>
    Verification:
      HMAC-SHA256(webhook_secret, f"{ts}:{raw_body}")
    """

    def __init__(self, billing: BillingStore, webhook_secret: str) -> None:
        self._billing = billing
        self._secret = webhook_secret

    def handle(self, raw_body: bytes, signature_header: str) -> WebhookResult:
        """
        Verify signature and process the event. Always returns a result —
        never raises so the HTTP layer can always return a response.
        """
        if not self._verify(raw_body, signature_header):
            logger.warning("paddle webhook: signature verification failed")
            return WebhookResult(ok=False, status=401, message="Invalid signature")

        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError as exc:
            logger.warning("paddle webhook: invalid JSON: %s", exc)
            return WebhookResult(ok=False, status=400, message="Invalid JSON")

        event_type = payload.get("event_type", "")
        logger.info("paddle webhook: event_type=%r", event_type)

        try:
            self._dispatch(event_type, payload)
        except Exception as exc:
            logger.exception("paddle webhook: error handling event_type=%r: %s", event_type, exc)
            return WebhookResult(ok=False, status=500, message=str(exc))

        return WebhookResult(ok=True, status=200, message="OK")

    def _verify(self, raw_body: bytes, signature_header: str) -> bool:
        if not self._secret:
            # No secret configured — skip verification (dev/test only)
            logger.debug("paddle webhook: no secret configured, skipping signature check")
            return True
        try:
            parts = dict(p.split("=", 1) for p in signature_header.split(";"))
            ts = parts.get("ts", "")
            h1 = parts.get("h1", "")
        except Exception:
            return False
        signed_payload = f"{ts}:{raw_body.decode('utf-8', errors='replace')}"
        expected = hmac.new(
            self._secret.encode(),
            signed_payload.encode(),
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(expected, h1)

    def _dispatch(self, event_type: str, payload: dict) -> None:
        if event_type == "transaction.completed":
            self._on_transaction_completed(payload)
        elif event_type == "subscription.activated":
            self._on_subscription_activated(payload)
        elif event_type == "subscription.cancelled":
            self._on_subscription_cancelled(payload)
        elif event_type == "subscription.updated":
            self._on_subscription_updated(payload)
        else:
            logger.debug("paddle webhook: unhandled event_type=%r", event_type)

    def _on_transaction_completed(self, payload: dict) -> None:
        data = payload.get("data", {})
        transaction_id = data.get("id", "")
        if not transaction_id:
            logger.warning("paddle webhook: transaction.completed missing id")
            return

        items = data.get("items", [])
        for item in items:
            price = item.get("price", {})
            price_id = price.get("id", "")
            credits = PRICE_CREDITS.get(price_id, 0)
            if credits:
                self._billing.add_credits(
                    credits=credits,
                    transaction_id=transaction_id,
                    price_id=price_id,
                )
                return

        logger.warning(
            "paddle webhook: transaction.completed — no recognised price_id in items"
        )

    def _on_subscription_activated(self, payload: dict) -> None:
        data = payload.get("data", {})
        subscription_id = data.get("id", "")
        items = data.get("items", [])
        price_id = ""
        for item in items:
            pid = item.get("price", {}).get("id", "")
            if pid in PRICE_CREDITS:
                price_id = pid
                break
        self._billing.set_auto_reload(
            enabled=True,
            price_id=price_id,
            subscription_id=subscription_id,
        )

    def _on_subscription_cancelled(self, payload: dict) -> None:
        data = payload.get("data", {})
        subscription_id = data.get("id", "")
        self._billing.set_auto_reload(
            enabled=False,
            subscription_id=subscription_id,
        )

    def _on_subscription_updated(self, payload: dict) -> None:
        data = payload.get("data", {})
        subscription_id = data.get("id", "")
        items = data.get("items", [])
        price_id = ""
        for item in items:
            pid = item.get("price", {}).get("id", "")
            if pid in PRICE_CREDITS:
                price_id = pid
                break
        if price_id:
            self._billing.set_auto_reload(
                enabled=True,
                price_id=price_id,
                subscription_id=subscription_id,
            )
