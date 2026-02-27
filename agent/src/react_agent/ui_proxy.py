"""
UI Proxy API для React UI.

Задача:
- React UI обращается к http://127.0.0.1:8090/api/...
- этот сервис проксирует запросы в LangGraph API (обычно http://127.0.0.1:2024)

Зачем:
- проще CORS (UI и API на одном хосте/домене)
- потом можно добавлять авторизацию/логирование/кеширование
- единый "локальный продукт": UI + proxy + LangGraph
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware


LANGGRAPH_BASE_URL = os.environ.get("LANGGRAPH_BASE_URL", "http://127.0.0.1:2024")
PROXY_HOST = os.environ.get("UI_PROXY_HOST", "127.0.0.1")
PROXY_PORT = int(os.environ.get("UI_PROXY_PORT", "8090"))

app = FastAPI(title="UI Proxy", version="0.1.0")

# На старте разработки разрешаем всё, чтобы не мешало.
# Позже сузим до конкретных origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "langgraph_base": LANGGRAPH_BASE_URL}


async def _proxy(request: Request, path: str) -> Response:
    """
    Проксирование "как есть":
    - метод (GET/POST/PUT/DELETE)
    - query params
    - body
    - основные headers
    """
    url = f"{LANGGRAPH_BASE_URL}/{path}"

    # Важно: не прокидываем host/connection и прочие hop-by-hop заголовки
    hop_by_hop = {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "host",
    }

    headers: Dict[str, str] = {}
    for k, v in request.headers.items():
        lk = k.lower()
        if lk in hop_by_hop:
            continue
        headers[k] = v

    body = await request.body()
    params = dict(request.query_params)

    timeout = httpx.Timeout(60.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.request(
            method=request.method,
            url=url,
            params=params,
            content=body if body else None,
            headers=headers,
        )

    # Возвращаем ответ как есть
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers={
            k: v
            for k, v in resp.headers.items()
            if k.lower() not in {"content-encoding", "transfer-encoding", "connection"}
        },
        media_type=resp.headers.get("content-type"),
    )


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def api_proxy(path: str, request: Request) -> Response:
    try:
        return await _proxy(request, path)
    except httpx.ConnectError:
        return JSONResponse(
            {"error": "LangGraph API недоступен", "base_url": LANGGRAPH_BASE_URL},
            status_code=502,
        )
    except Exception as e:
        return JSONResponse(
            {"error": "Proxy error", "detail": str(e)},
            status_code=500,
        )


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=PROXY_HOST, port=PROXY_PORT)


if __name__ == "__main__":
    main()
