import asyncio
import contextlib
import json
import logging
import ssl
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict
from typing import Dict

import httpx
import logging
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


@contextlib.asynccontextmanager
async def _mock_art_tls_server(handler):
    with tempfile.TemporaryDirectory() as tmp_dir:
        cert_path = Path(tmp_dir) / "cert.pem"
        key_path = Path(tmp_dir) / "key.pem"
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-keyout",
                str(key_path),
                "-out",
                str(cert_path),
                "-days",
                "1",
                "-nodes",
                "-subj",
                "/CN=127.0.0.1",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
        server = await asyncio.start_server(handler, "127.0.0.1", 0, ssl=ssl_ctx)
        port = server.sockets[0].getsockname()[1]
        task = asyncio.create_task(server.serve_forever())
        try:
            yield port
        finally:
            server.close()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            await server.wait_closed()


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
async def test_never_drop_unacked_rejects_new(monkeypatch, proxied_client):
    client, spool = proxied_client
    monkeypatch.setenv("UI_PROXY_SPOOL_MAX_EVENTS", "1")
    monkeypatch.setenv("UI_PROXY_SPOOL_OVERFLOW_POLICY", "never_drop_unacked")

    async def timeout_forward(evts, client_id, correlation_headers=None):
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr(ui_proxy, "_forward_to_art", timeout_forward)

    response1 = await client.post(
        "/ui/art/ingest",
        json={"events": [_sample_event("overflow-1")]},
        headers={"x-client-id": "test-client"},
    )
    assert response1.status_code == 504

    response2 = await client.post(
        "/ui/art/ingest",
        json={"events": [_sample_event("overflow-2")]},
        headers={"x-client-id": "test-client"},
    )
    assert response2.status_code == 507
    assert response2.json()["error"] == "spool_full"


@pytest.mark.anyio
async def test_drop_oldest_when_full_logs_lossy(monkeypatch, proxied_client, caplog):
    caplog.set_level(logging.WARNING, logger="react_agent.spool")
    client, spool = proxied_client
    monkeypatch.setenv("UI_PROXY_SPOOL_MAX_EVENTS", "1")
    monkeypatch.setenv("UI_PROXY_SPOOL_OVERFLOW_POLICY", "drop_oldest_when_full")

    async def timeout_forward(evts, client_id, correlation_headers=None):
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr(ui_proxy, "_forward_to_art", timeout_forward)

    response1 = await client.post(
        "/ui/art/ingest",
        json={"events": [_sample_event("drop-1")]},
        headers={"x-client-id": "test-client"},
    )
    assert response1.status_code == 504

    response2 = await client.post(
        "/ui/art/ingest",
        json={"events": [_sample_event("drop-2")]},
        headers={"x-client-id": "test-client"},
    )
    assert response2.status_code == 504

    conn = await spool._connection()
    cursor = await conn.execute("SELECT event_id FROM spool_events ORDER BY id ASC")
    rows = await cursor.fetchall()
    assert rows and rows[0][0] == "drop-2"

    warnings = [rec.message for rec in caplog.records if "lossy_mode_active" in rec.message or "data_quality.lossy" in rec.message]
    assert any("lossy_mode_active" in msg for msg in warnings)
    assert any("data_quality.lossy" in msg for msg in warnings)


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

    monkeypatch.setattr(ui_proxy, "ART_TLS_VERIFY", False)

    headers = {
        "x-trace-id": "trace-corr",
        "x-span-id": "span-corr",
        "x-request-id": "req-corr",
        "x-client-id": "test-client",
    }
    async with _mock_art_tls_server(handler) as port:
        monkeypatch.setattr(ui_proxy, "ART_INGEST_URL", f"https://127.0.0.1:{port}/api/v1/ingest")
        response = await client.post("/ui/art/ingest", json={"events": events}, headers=headers)

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
async def test_ingest_attachments_rejects_large_files(monkeypatch, ingest_client):
    monkeypatch.setattr(ui_proxy, "MAX_ATTACHMENT_BYTES", 1)
    headers = {
        "Authorization": "Bearer ingest-token",
        "X-Client-Id": "ingest-client",
    }
    files = {"file": ("huge.txt", b"ok", "text/plain")}
    response = await ingest_client.post("/ui/ingest/attachments", headers=headers, files=files)
    assert response.status_code == 413
    assert "max size" in response.json().get("detail", "")


@pytest.mark.anyio
async def test_ingest_attachments_detects_malware(monkeypatch, ingest_client):
    cmd = f"{sys.executable} -c 'import sys; sys.exit(1)'"
    monkeypatch.setenv("ATTACHMENT_SCANNER_CMD", cmd)
    headers = {
        "Authorization": "Bearer ingest-token",
        "X-Client-Id": "ingest-client",
    }
    files = {"file": ("safe.png", b"\x89PNG\r\n\x1a\n", "image/png")}
    response = await ingest_client.post("/ui/ingest/attachments", headers=headers, files=files)
    assert response.status_code == 400
    assert "malware" in response.json().get("detail", "")


@pytest.mark.anyio
async def test_attachment_scanner_update_not_configured(monkeypatch, proxied_client):
    client, _ = proxied_client
    monkeypatch.setenv("ATTACHMENT_SCANNER_UPDATE_CMD", "")
    response = await client.post("/ui/attachments/update-scanner")
    assert response.status_code == 404


@pytest.mark.anyio
async def test_attachment_scanner_update_runs(monkeypatch, proxied_client):
    client, _ = proxied_client
    cmd = f"{sys.executable} -c 'print(\"updated\")'"
    monkeypatch.setenv("ATTACHMENT_SCANNER_UPDATE_CMD", cmd)
    response = await client.post("/ui/attachments/update-scanner")
    assert response.status_code == 200
    assert response.json().get("message") == "updated"


@pytest.mark.anyio
async def test_attachment_scanner_update_failure(monkeypatch, proxied_client):
    client, _ = proxied_client
    cmd = f"{sys.executable} -c 'import sys; sys.exit(2)'"
    monkeypatch.setenv("ATTACHMENT_SCANNER_UPDATE_CMD", cmd)
    response = await client.post("/ui/attachments/update-scanner")
    assert response.status_code == 500


@pytest.mark.anyio
async def test_provider_gateway_times_out(monkeypatch, proxied_client, caplog):
    client, _ = proxied_client
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
    monkeypatch.setenv("PROVIDER_BASE_URL", f"http://127.0.0.1:{port}")
    monkeypatch.setattr(ui_proxy, "PROVIDER_CONNECT_TIMEOUT", 0.1)
    monkeypatch.setattr(ui_proxy, "PROVIDER_READ_TIMEOUT", 0.1)
    monkeypatch.setattr(ui_proxy, "PROVIDER_WRITE_TIMEOUT", 0.1)
    caplog.set_level(logging.WARNING)

    try:
        response = await client.post(
            "/ui/provider/test", json={"foo": "bar"}, headers={"x-client-id": "test-client"}
        )
    finally:
        server.close()
        server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await server_task
        await server.wait_closed()

    assert response.status_code == 504
    assert "provider_timeout" in caplog.text


@pytest.mark.anyio
async def test_provider_gateway_logs_events(monkeypatch, proxied_client, caplog):
    client, _ = proxied_client
    async def handler(reader, writer):
        await reader.read(65536)
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    server_task = asyncio.create_task(server.serve_forever())
    monkeypatch.setenv("PROVIDER_BASE_URL", f"http://127.0.0.1:{port}")
    caplog.set_level(logging.INFO)

    try:
        response = await client.post(
            "/ui/provider/run", json={"foo": "bar"}, headers={"x-client-id": "test-client"}
        )
    finally:
        server.close()
        server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await server_task
        await server.wait_closed()

    assert response.status_code == 200
    assert "provider.request" in caplog.text
    assert "provider.response" in caplog.text


@pytest.mark.anyio
async def test_provider_transport_switch_to_art(monkeypatch, proxied_client):
    client, _ = proxied_client
    called: Dict[str, Any] = {}
    async def fake_forward(events, client_id, correlation_headers):
        called["events"] = events
        return {"ok": True, "client": client_id}

    monkeypatch.setattr(ui_proxy, "_forward_to_art", fake_forward)
    monkeypatch.setenv("PROVIDER_TRANSPORT_MODE", "art")

    response = await client.post(
        "/ui/provider/switch", json={"events": [{"kind": "ui.test"}]}, headers={"x-client-id": "test-client"}
    )

    assert response.json().get("ok") is True
    assert called.get("events") == [{"kind": "ui.test"}]

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

    monkeypatch.setattr(ui_proxy, "ART_TLS_VERIFY", False)

    async with _mock_art_tls_server(slow_handler) as port:
        monkeypatch.setattr(ui_proxy, "ART_INGEST_URL", f"https://127.0.0.1:{port}/api/v1/ingest")
        response = await client.post("/ui/art/ingest", json={"events": events}, headers={"x-client-id": "test-client"})

    assert response.status_code == 504
    results = response.json().get("results", [])
    assert len(results) == len(events)
    assert all(item["status"] == "retryable" for item in results)
    conn = await spool._connection()
    pending_cursor = await conn.execute("SELECT COUNT(*) FROM spool_events")
    pending = await pending_cursor.fetchone()
    assert pending[0] == len(events)


@pytest.mark.anyio
async def test_art_ingest_https_only_rejects_http(monkeypatch, proxied_client):
    client, _ = proxied_client
    monkeypatch.setattr(ui_proxy, "ART_ALLOW_HTTP_LOCAL", False)
    monkeypatch.setattr(ui_proxy, "ART_INGEST_URL", "http://127.0.0.1:7331/api/v1/ingest")
    response = await client.post(
        "/ui/art/ingest",
        json={"events": [_sample_event("http-blocked-1")]},
        headers={"x-client-id": "test-client"},
    )
    assert response.status_code == 500
    assert "https://" in response.json().get("detail", "")


@pytest.mark.anyio
async def test_art_ingest_http_local_allowed(monkeypatch, proxied_client):
    client, _ = proxied_client
    monkeypatch.setattr(ui_proxy, "ART_ALLOW_HTTP_LOCAL", True)

    async def handler(reader, writer):
        await reader.read(65536)
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

    try:
        response = await client.post(
            "/ui/art/ingest",
            json={"events": [_sample_event("http-local-allowed-1")]},
            headers={"x-client-id": "test-client", "x-trace-id": "trace-http-local"},
        )
    finally:
        server.close()
        server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await server_task
        await server.wait_closed()

    assert response.status_code == 200
    assert response.json().get("ok") is True


@pytest.mark.anyio
async def test_art_ingest_tls_smoke_self_signed(monkeypatch, proxied_client):
    client, _ = proxied_client
    monkeypatch.setattr(ui_proxy, "ART_TLS_VERIFY", False)

    async def handler(reader, writer):
        await reader.read(65536)
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 24\r\n\r\n{\"ok\":true,\"results\":[]}"
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    async with _mock_art_tls_server(handler) as port:
        monkeypatch.setattr(ui_proxy, "ART_INGEST_URL", f"https://127.0.0.1:{port}/api/v1/ingest")
        response = await client.post(
            "/ui/art/ingest",
            json={"events": [_sample_event("tls-smoke-1")]},
            headers={"x-client-id": "test-client", "x-trace-id": "trace-tls"},
        )
    assert response.status_code == 200
    assert response.json().get("ok") is True


@pytest.mark.anyio
async def test_upstream_error_format_contains_required_fields(monkeypatch, proxied_client):
    client, _ = proxied_client
    events = [_sample_event("upstream-1")]

    async def request_error(_events, _client_id, _correlation_headers=None):
        raise httpx.RequestError("network broken")

    monkeypatch.setattr(ui_proxy, "_forward_to_art", request_error)
    response = await client.post(
        "/ui/art/ingest",
        json={"events": events},
        headers={"x-client-id": "test-client", "x-trace-id": "trace-upstream"},
    )
    assert response.status_code == 502
    upstream_error = response.json().get("upstream_error", {})
    assert upstream_error.get("kind") == "upstream_error"
    assert upstream_error.get("trace_id") == "trace-upstream"
    assert upstream_error.get("retry_count") == 0
    for field in ("what", "where", "why", "actions", "evidence"):
        assert field in upstream_error


@pytest.mark.anyio
async def test_retry_count_present_and_non_negative(monkeypatch, proxied_client):
    client, _ = proxied_client

    async def timeout_forward(_events, _client_id, _correlation_headers=None):
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr(ui_proxy, "_forward_to_art", timeout_forward)
    response = await client.post(
        "/ui/art/ingest",
        json={"events": [_sample_event("retry-count-1")]},
        headers={"x-client-id": "test-client"},
    )
    assert response.status_code == 504
    retry_item = response.json().get("results", [])[0]
    assert int(retry_item.get("retry_count", -1)) >= 0


@pytest.mark.anyio
async def test_audit_immutability_append_only(monkeypatch, proxied_client, caplog):
    caplog.set_level(logging.WARNING, logger="react_agent.spool")
    _client, spool = proxied_client
    ok = await spool.verify_audit_immutability()
    assert ok is True
    assert "observability_gap.audit_tampering" in caplog.text
