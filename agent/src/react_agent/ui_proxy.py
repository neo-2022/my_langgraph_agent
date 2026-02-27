"""
UI Proxy API для React UI.

1) /api/*  -> прокси в LangGraph API (127.0.0.1:2024)
2) /ui/*   -> "удобные" эндпоинты для локального UI:
   - список моделей Ollama
   - сохранить модель в .env
   - перезапуск tmux-сессии langgraph
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware

from react_agent.context import Context


LANGGRAPH_BASE_URL = os.environ.get("LANGGRAPH_BASE_URL", "http://127.0.0.1:2024")
PROXY_HOST = os.environ.get("UI_PROXY_HOST", "127.0.0.1")
PROXY_PORT = int(os.environ.get("UI_PROXY_PORT", "8090"))

# Где лежит .env (в корне agent-проекта)
ENV_PATH = (Path(__file__).resolve().parent / ".." / ".." / ".env").resolve()

# Команда запуска LangGraph (то же, что ты запускал в tmux)
LANGGRAPH_TMUX_CMD = os.environ.get(
    "LANGGRAPH_TMUX_CMD",
    "cd ~/my_langgraph_agent/agent && source ../venv/bin/activate && langgraph dev --no-browser",
)

app = FastAPI(title="UI Proxy", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "langgraph_base": LANGGRAPH_BASE_URL,
        "env_path": str(ENV_PATH),
    }


# ---------- helpers (.env) ----------

def _read_env_lines() -> List[str]:
    if not ENV_PATH.exists():
        return []
    return ENV_PATH.read_text(encoding="utf-8").splitlines()


def _write_env_lines(lines: List[str]) -> None:
    ENV_PATH.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _set_env_key(key: str, value: str) -> None:
    key = key.strip()
    lines = _read_env_lines()
    out: List[str] = []
    found = False

    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            out.append(line)
            continue
        if line.startswith(f"{key}="):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(line)

    if not found:
        out.append(f"{key}={value}")

    _write_env_lines(out)


def _get_env_key(key: str) -> str:
    key = key.strip()
    for line in _read_env_lines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip()
    return ""


# ---------- tmux helpers ----------

def _tmux_has_session(name: str) -> bool:
    p = subprocess.run(
        ["tmux", "has-session", "-t", name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return p.returncode == 0


def _tmux_restart_langgraph() -> Dict[str, Any]:
    """
    Простыми словами: "остановить и снова запустить LangGraph сервер, который сидит в tmux".
    """
    if not _tmux_has_session("langgraph"):
        return {"ok": False, "error": "tmux-сессия langgraph не найдена"}

    # 1) Ctrl+C (остановить)
    subprocess.run(["tmux", "send-keys", "-t", "langgraph", "C-c"], check=False)
    # 2) запуск той же команды
    subprocess.run(
        ["tmux", "send-keys", "-t", "langgraph", LANGGRAPH_TMUX_CMD, "Enter"],
        check=False,
    )

    return {"ok": True}


# ---------- /ui endpoints ----------

@app.get("/ui/models")
def ui_models() -> Dict[str, Any]:
    """
    Возвращает:
    - models: список моделей Ollama (из Context.available_models)
    - current: текущая модель из .env (MODEL=...), если есть
    - default: дефолт из Context.model
    """
    ctx = Context()
    current = _get_env_key("MODEL") or ctx.model
    return {
        "models": list(ctx.available_models),
        "current": current,
        "default": ctx.model,
    }


@app.post("/ui/model")
async def ui_set_model(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    payload: { "model": "..." }
    Сохраняет MODEL=... в .env
    """
    model = str(payload.get("model", "")).strip()
    if not model:
        return JSONResponse({"ok": False, "error": "model пустой"}, status_code=400)

    # Небольшая валидация: модель должна быть в available_models
    ctx = Context()
    if model not in ctx.available_models:
        return JSONResponse(
            {"ok": False, "error": "Такой модели нет в ollama list", "models": list(ctx.available_models)},
            status_code=400,
        )

    _set_env_key("MODEL", model)
    return {"ok": True, "model": model, "env_path": str(ENV_PATH)}


@app.post("/ui/restart-langgraph")
def ui_restart_langgraph() -> Dict[str, Any]:
    return _tmux_restart_langgraph()


# ---------- /api proxy to LangGraph ----------

async def _proxy(request: Request, path: str) -> Response:
    url = f"{LANGGRAPH_BASE_URL}/{path}"

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
        if k.lower() in hop_by_hop:
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
        return JSONResponse({"error": "Proxy error", "detail": str(e)}, status_code=500)


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=PROXY_HOST, port=PROXY_PORT)


if __name__ == "__main__":
    main()
