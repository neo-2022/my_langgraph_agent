import asyncio
import contextlib
import json
import urllib.parse

import httpx
import pytest

from react_agent import ui_proxy


@contextlib.asynccontextmanager
async def _mock_art_stream(handler):
    server = await asyncio.start_server(handler, "127.0.0.1", 0)
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


async def _default_handler(reader, writer, *, response_headers=None):
    data = await reader.read(4096)
    request_line = data.decode("utf-8", "ignore").splitlines()[0]
    path = request_line.split(" ")[1]
    headers = {
        "Content-Type": "text/event-stream",
        "Retry-After": "5",
        **(response_headers or {}),
    }
    header_lines = "\r\n".join(f"{k}: {v}" for k, v in headers.items())
    writer.write(f"HTTP/1.1 200 OK\r\n{header_lines}\r\n\r\n".encode())
    payload = json.dumps({"cursor": "c1", "sequence_id": 1})
    writer.write(f"data: {payload}\n\n".encode())
    await writer.drain()
    await asyncio.sleep(0.01)
    writer.close()
    await writer.wait_closed()
    return path


@pytest.mark.anyio
async def test_ui_art_stream_proxies_events(monkeypatch):
    paths = []

    async def handler(reader, writer):
        path = await _default_handler(reader, writer)
        paths.append(path)

    async with _mock_art_stream(handler) as port:
        monkeypatch.setattr(ui_proxy, "_ensure_art_tls_config", lambda: None)
        monkeypatch.setattr(ui_proxy, "ART_STREAM_URL", f"http://127.0.0.1:{port}/api/v1/stream")
        transport = httpx.ASGITransport(app=ui_proxy.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            async with client.stream("GET", "/ui/art/stream") as resp:
                assert resp.headers.get("content-type", "").startswith("text/event-stream")
                await resp.aread()
    assert paths and paths[0] == "/api/v1/stream"


@pytest.mark.anyio
async def test_ui_art_stream_respects_cursor_param(monkeypatch):
    seen_query = []

    async def handler(reader, writer):
        path = await _default_handler(reader, writer)
        parsed = urllib.parse.urlparse(path)
        seen_query.append(parsed.query)

    async with _mock_art_stream(handler) as port:
        monkeypatch.setattr(ui_proxy, "_ensure_art_tls_config", lambda: None)
        monkeypatch.setattr(ui_proxy, "ART_STREAM_URL", f"http://127.0.0.1:{port}/api/v1/stream")
        transport = httpx.ASGITransport(app=ui_proxy.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            async with client.stream("GET", "/ui/art/stream", params={"cursor": "resume-123"}) as resp:
                await resp.aread()
    assert seen_query and "cursor=resume-123" in seen_query[0]


@pytest.mark.anyio
async def test_ui_art_stream_retries_after_header(monkeypatch):
    async def handler(reader, writer):
        return await _default_handler(reader, writer, response_headers={"Retry-After": "10"})

    async with _mock_art_stream(handler) as port:
        monkeypatch.setattr(ui_proxy, "_ensure_art_tls_config", lambda: None)
        monkeypatch.setattr(ui_proxy, "ART_STREAM_URL", f"http://127.0.0.1:{port}/api/v1/stream")
        transport = httpx.ASGITransport(app=ui_proxy.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            async with client.stream("GET", "/ui/art/stream") as resp:
                await resp.aread()
                assert resp.headers.get("retry-after") == "10"
