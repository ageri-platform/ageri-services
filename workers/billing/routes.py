"""
ageri/web/routes/billing.py — Paddle webhook endpoint + balance API.

Routes:
  POST /webhook/paddle      — Paddle event receiver (signature-verified)
  GET  /api/billing/balance — Current credit balance + auto-reload info
  GET  /api/billing/history — Transaction history (last 20)
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Header, HTTPException, Request, Response

from ageri.billing import BillingStore, PaddleWebhookHandler

logger = logging.getLogger(__name__)


def make_router(billing: BillingStore, webhook_secret: str) -> APIRouter:
    router = APIRouter()
    handler = PaddleWebhookHandler(billing, webhook_secret)

    @router.post("/webhook/paddle")
    async def paddle_webhook(
        request: Request,
        paddle_signature: str = Header(default="", alias="Paddle-Signature"),
    ) -> Response:
        raw_body = await request.body()
        result = await asyncio.to_thread(handler.handle, raw_body, paddle_signature)
        return Response(content=result.message, status_code=result.status)

    @router.get("/api/billing/balance")
    async def get_balance() -> dict:
        return await asyncio.to_thread(billing.get_billing_info)

    @router.get("/api/billing/history")
    async def get_history() -> list:
        return await asyncio.to_thread(billing.get_transaction_history)

    return router
