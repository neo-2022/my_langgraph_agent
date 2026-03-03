import asyncio
import contextlib
import json
from pathlib import Path
from typing import Dict
from typing import Dict

import httpx
import pytest

from react_agent import ui_proxy
from react_agent.spool import Spool


def _sample_event(event_id: str) -> dict:
    return {
        "event_id": event_id,
        "schema_version": "REGART.Art.RawEvent.v1",
        "kind": "ui.test",
        "scope": "ui",
        "severity": "info",
        "message": "payload",
    }


@pytest.fixture
async def proxied_client(tmp_path, monkeypatch):
    spool_db = tmp_path / "spool.db"
    spool = Spool(path=spool_db)
    await spool.ensure_schema()
    monkeypatch.setattr(ui_proxy, "spool", spool)
    transport = httpx.ASGITransport(app=ui_proxy.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, spool
    await spool.close()


@pytest.fixture
async def ingest_client(monkeypatch):
    monkeypatch.setattr(ui_proxy, "INGEST_BEARER_TOKEN", "ingest-token")
    monkeypatch.setattr(ui_proxy, "ALLOWED_INGEST_CLIENT_IDS", {"ingest-client"})
    transport = httpx.ASGITransport(app=ui_proxy.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


@pytest.mark.anyio
async def test_partial_ack_response_moves_to_dlq_and_retry(proxied_client, monkeypatch):
    client, spool = proxied_client
    events = [_sample_event(f"evt-{i}") for i in range(3)]

    async def fake_forward(evts, client_id, correlation_headers=None):
        return {
            "ok": True,
            "accepted": 1,
            "results": [
                {"event_id": evts[0]["event_id"], "status": "accepted"},
                {"event_id": evts[1]["event_id"], "status": "retryable"},
                {"event_id": evts[2]["event_id"], "status": "rejected", "reason": "malformed"},
            ],
        }

    monkeypatch.setattr(ui_proxy, "_forward_to_art", fake_forward)

    response = await client.post("/ui/art/ingest", json={"events": events}, headers={"x-client-id": "test-client"})
    assert response.json()["results"][0]["status"] == "accepted"
    conn = await spool._connection()
    cursor = await conn.execute("SELECT event_id, status FROM spool_events")
    rows = await cursor.fetchall()
    assert rows == []  # retryable events stay out of spool during partial ack handling
    dlq_cursor = await conn.execute("SELECT event_id, reason FROM spool_dlq")
    dlq = await dlq_cursor.fetchall()
    assert dlq and dlq[0][0] == events[2]["event_id"]


@pytest.mark.anyio
async def test_timeout_spools_events_for_later_replay(proxied_client, monkeypatch):
    client, spool = proxied_client
    events = [_sample_event(f"timeout-{i}") for i in range(2)]

    async def timeout_forward(evts, client_id, correlation_headers=None):
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr(ui_proxy, "_forward_to_art", timeout_forward)

    response = await client.post("/ui/art/ingest", json={"events": events}, headers={"x-client-id": "test-client"})
    assert response.status_code == 504
    assert all(item["status"] == "retryable" for item in response.json()["results"])
    conn = await spool._connection()
    pending_cursor = await conn.execute("SELECT COUNT(*) FROM spool_events")
    pending = await pending_cursor.fetchone()
    assert pending[0] == len(events)


@pytest.mark.anyio
async def test_art_ingest_preserves_correlation_headers(monkeypatch, proxied_client):
    client, _ = proxied_client
    seen_headers: Dict[str, str] = {}
    events = [_sample_event("corr-1")]

    async def handler(reader, writer):
        data = await reader.read(65536)
        payload = data.decode("utf-8", errors="ignore")
        head = payload.split("\r\n\r\n", 1)[0]
        for line in head.split("\r\n")[1:]:
            if ":" in line:
                key, value = line.split(":", 1)
                seen_headers[key.lower()] = value.strip()
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 24\r\n\r\n{\"ok\":true,\"results\":[]}"
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    server_task = asyncio.create_task(server.serve_forever())
    monkeypatch.setattr(ui_proxy, "ART_INGEST_URL", f"http://127.0.0.1:{port}/api/v1/ingest")

    headers = {
        "x-trace-id": "trace-corr",
        "x-span-id": "span-corr",
        "x-request-id": "req-corr",
        "x-client-id": "test-client",
    }
    try:
        response = await client.post("/ui/art/ingest", json={"events": events}, headers=headers)
    finally:
        server.close()
        server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await server_task
        await server.wait_closed()

    assert response.status_code == 200
    assert seen_headers.get("x-trace-id") == "trace-corr"
    assert seen_headers.get("x-span-id") == "span-corr"
    assert seen_headers.get("x-request-id") == "req-corr"


@pytest.mark.anyio
async def test_ingest_events_requires_auth(ingest_client):
    response = await ingest_client.post("/ui/ingest/events", json={"events": []})
    assert response.status_code == 401


@pytest.mark.anyio
async def test_ingest_events_validation_error(ingest_client):
    headers = {
        "Authorization": "Bearer ingest-token",
        "X-Client-Id": "ingest-client",
    }
    payload = {
        "events": [
            {
                "event_id": "invalid-1",
                "schema_version": "REGART.Art.RawEvent.v1",
                "kind": "ui.test",
                "scope": "ui",
                # missing severity/message/timestamp -> should fail
            }
        ]
    }
    response = await ingest_client.post("/ui/ingest/events", headers=headers, json=payload)
    assert response.status_code == 422
    detail = response.json().get("detail", {})
    assert detail.get("index") == 0
    assert isinstance(detail.get("errors"), list)


@pytest.mark.anyio
async def test_ingest_events_redacts_sensitive_fields(ingest_client):
    headers = {
        "Authorization": "Bearer ingest-token",
        "X-Client-Id": "ingest-client",
    }
    payload = {
        "events": [
            {
                "event_id": "redact-1",
                "schema_version": "REGART.Art.RawEvent.v1",
                "kind": "ui.test",
                "scope": "ui",
                "severity": "info",
                "message": "payload",
                "timestamp": "2026-01-01T00:00:00Z",
                "session_id": "sess-1",
                "sequence_id": 1,
                "title": "redact test",
                "attachments": [],
                "content_hash": "hash-value",
                "version_history": ["REGART.Art.RawEvent.v1"],
                "payload": {
                    "password": "topsecret",
                    "nested": {"token": "abc"},
                },
            }
        ]
    }
    response = await ingest_client.post("/ui/ingest/events", headers=headers, json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["validated"] == 1
    redacted = data["redacted_events"][0]["payload"]
    assert redacted["password"] == ui_proxy.REDACTED_MARKER
    assert redacted["nested"]["token"] == ui_proxy.REDACTED_MARKER


@pytest.mark.anyio
async def test_ingest_attachments_requires_auth(ingest_client):
    files = {"file": ("safe.txt", b"ok", "text/plain")}
    response = await ingest_client.post("/ui/ingest/attachments", files=files)
    assert response.status_code == 401


@pytest.mark.anyio
async def test_ingest_attachments_rejects_path_traversal(ingest_client):
    headers = {
        "Authorization": "Bearer ingest-token",
        "X-Client-Id": "ingest-client",
    }
    files = {"file": ("../evil.png", b"\x89PNG\r\n\x1a\n", "image/png")}
    response = await ingest_client.post("/ui/ingest/attachments", headers=headers, files=files)
    assert response.status_code == 400
    assert "unsafe" in response.json().get("detail", "")


@pytest.mark.anyio
async def test_ingest_attachments_rejects_magic_mismatch(ingest_client):
    headers = {
        "Authorization": "Bearer ingest-token",
        "X-Client-Id": "ingest-client",
    }
    files = {"file": ("image.png", b"notpng", "image/png")}
    response = await ingest_client.post("/ui/ingest/attachments", headers=headers, files=files)
    assert response.status_code == 400
    assert "signature" in response.json().get("detail", "")

@pytest.mark.anyio
async def test_art_read_timeout_respects_policy(monkeypatch, proxied_client):
    client, spool = proxied_client
    events = [_sample_event(f"slow-{i}") for i in range(2)]

    # Force short timeouts so we hit the read timeout during the test.
    monkeypatch.setattr(ui_proxy, "ART_CONNECT_TIMEOUT", 0.1)
    monkeypatch.setattr(ui_proxy, "ART_READ_TIMEOUT", 0.1)
    monkeypatch.setattr(ui_proxy, "ART_WRITE_TIMEOUT", 0.1)

    async def slow_handler(reader, writer):
        await reader.read(65536)
        await asyncio.sleep(0.5)
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(slow_handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    server_task = asyncio.create_task(server.serve_forever())
    monkeypatch.setattr(ui_proxy, "ART_INGEST_URL", f"http://127.0.0.1:{port}/api/v1/ingest")

    try:
        response = await client.post("/ui/art/ingest", json={"events": events}, headers={"x-client-id": "test-client"})
    finally:
        server.close()
        server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await server_task
        await server.wait_closed()

    assert response.status_code == 504
    results = response.json().get("results", [])
    assert len(results) == len(events)
    assert all(item["status"] == "retryable" for item in results)
    conn = await spool._connection()
    pending_cursor = await conn.execute("SELECT COUNT(*) FROM spool_events")
    pending = await pending_cursor.fetchone()
    assert pending[0] == len(events)
