"""
UI Proxy API для React UI.

1) /api/*  -> прокси в LangGraph API (127.0.0.1:2024)
2) /ui/*   -> "удобные" эндпоинты для локального UI:
   - список моделей Ollama
   - сохранить модель в .env
   - перезапуск tmux-сессии langgraph
   - probe tool_calls (проверка поддержки tool calling у моделей)

Важно по Debugger:
- Для "100% ошибок" нужны источники вне браузера:
  - Vite/dev-server (tmux session ui)
  - LangGraph (tmux session langgraph)
  - UI Proxy (tmux session ui_proxy)
  - и будущие сервисы (cloud models/tools/etc).
- Поэтому ui_proxy даёт эндпоинты статуса и логов по tmux (чтобы ошибки сборки/процессов были видимы всегда).
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware

from react_agent.context import Context
from react_agent.tools import probe_tool_calls, probe_all_models_tool_calls


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

# Команда запуска UI Proxy (tmux session ui_proxy)
UI_PROXY_TMUX_CMD = os.environ.get(
    "UI_PROXY_TMUX_CMD",
    "cd ~/my_langgraph_agent/agent && source ../venv/bin/activate && UI_PROXY_PORT=8090 python -m uvicorn react_agent.ui_proxy:app --host 127.0.0.1 --port 8090",
)

# Кэш probe (чтобы не мучить большие модели постоянно)
PROBE_CACHE_TTL_SECONDS = int(os.environ.get("PROBE_CACHE_TTL_SECONDS", "3600"))  # 1h
_PROBE_CACHE: Dict[str, Dict[str, Any]] = {}  # model -> { ok: bool, ts: float, raw: dict }

app = FastAPI(title="UI Proxy", version="0.3.0")

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
        "probe_cache_ttl_seconds": PROBE_CACHE_TTL_SECONDS,
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


def _tmux_capture_pane(name: str, lines: int = 200) -> Dict[str, Any]:
    """
    Возвращает текст из tmux pane для сессии `name` (последние N строк).
    Это нужно для "100% ошибок" (например, ошибки сборки Vite/Babel в tmux session ui).
    """
    if not _tmux_has_session(name):
        return {"ok": False, "error": f"tmux-сессия {name} не найдена", "tmux_session": False}

def _systemd_user_journal(unit: str, lines: int = 200) -> Dict[str, Any]:
    """
    Возвращает последние N строк логов systemd user unit через journalctl.
    Нужно для "100% ошибок" для сервисов, которые не в tmux (например React UI как systemd service).
    """
    n = int(lines or 200)
    n = max(20, min(2000, n))
    try:
        r = subprocess.run(
            ["journalctl", "--user", "-u", unit, "-n", str(n), "--no-pager"],
            text=True,
            capture_output=True,
            check=False,
        )
        if r.returncode != 0:
            return {"ok": False, "unit": unit, "lines": n, "error": (r.stderr.strip() or r.stdout.strip() or "journalctl failed"), "text": ""}
        return {"ok": True, "unit": unit, "lines": n, "text": (r.stdout or "").rstrip("\n")}
    except Exception as e:
        return {"ok": False, "unit": unit, "lines": n, "error": str(e), "text": ""}


    n = int(lines or 200)
    n = max(20, min(2000, n))  # лимитируем, чтобы не тащить мегабайты

    # capture-pane:
    # -p: print
    # -S -N: start line from -N (последние N)
    try:
        r = subprocess.run(
            ["tmux", "capture-pane", "-t", name, "-p", "-S", f"-{n}"],
            text=True,
            capture_output=True,
            check=False,
        )
        txt = (r.stdout or "").rstrip("\n")
        return {"ok": True, "tmux_session": True, "lines": n, "text": txt}
    except Exception as e:
        return {"ok": False, "tmux_session": True, "error": str(e), "lines": n, "text": ""}


def _http_health(url: str) -> Dict[str, Any]:
    try:
        r = httpx.get(url, timeout=2.0)
        return {"ok": bool(r.status_code == 200), "status_code": int(r.status_code)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _tmux_stop_session(name: str) -> Dict[str, Any]:
    if not _tmux_has_session(name):
        return {"ok": False, "error": f"tmux-сессия {name} не найдена"}
    subprocess.run(["tmux", "send-keys", "-t", name, "C-c"], check=False)
    return {"ok": True}


def _tmux_start_session(name: str, cmd: str) -> Dict[str, Any]:
    if not _tmux_has_session(name):
        subprocess.run(["tmux", "new-session", "-d", "-s", name, cmd], check=False)
        return {"ok": True, "created": True}
    subprocess.run(["tmux", "send-keys", "-t", name, cmd, "Enter"], check=False)
    return {"ok": True, "created": False}


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


def _langgraph_health() -> Dict[str, Any]:
    """
    Пытаемся понять, жив ли LangGraph по HTTP.
    """
    url = LANGGRAPH_BASE_URL.rstrip("/") + "/openapi.json"
    try:
        r = httpx.get(url, timeout=2.0)
        return {"ok": bool(r.status_code == 200), "status_code": int(r.status_code)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _tmux_stop_langgraph() -> Dict[str, Any]:
    if not _tmux_has_session("langgraph"):
        return {"ok": False, "error": "tmux-сессия langgraph не найдена"}
    subprocess.run(["tmux", "send-keys", "-t", "langgraph", "C-c"], check=False)
    return {"ok": True}


def _tmux_start_langgraph() -> Dict[str, Any]:
    """
    Запускаем LangGraph в tmux-сессии langgraph.
    Если сессии нет — создаём.
    Если есть — отправляем команду запуска.
    """
    if not _tmux_has_session("langgraph"):
        subprocess.run(["tmux", "new-session", "-d", "-s", "langgraph", LANGGRAPH_TMUX_CMD], check=False)
        return {"ok": True, "created": True}
    subprocess.run(["tmux", "send-keys", "-t", "langgraph", LANGGRAPH_TMUX_CMD, "Enter"], check=False)
    return {"ok": True, "created": False}


# ---------- /api proxy ----------

@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy_api(path: str, request: Request) -> Response:
    # Проксируем /api/* в LangGraph API.
    # Важно для "100% ошибок": если LangGraph недоступен, возвращаем структурированную JSON-ошибку
    # (service/upstream/hint), чтобы UI Debugger показал человеку понятную причину и что делать.
    url = LANGGRAPH_BASE_URL.rstrip("/") + "/" + path
    method = request.method
    headers = dict(request.headers)
    headers.pop("host", None)

    body = await request.body()

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.request(
                method,
                url,
                headers=headers,
                content=body,
                params=dict(request.query_params),
            )
            return Response(
                content=r.content,
                status_code=r.status_code,
                headers=dict(r.headers),
                media_type=r.headers.get("content-type"),
            )
    except (httpx.ConnectError, httpx.NetworkError) as e:
        # LangGraph не отвечает / connection refused / network issue
        return JSONResponse(
            {
                "ok": False,
                "error_type": "upstream_connect",
                "service": "langgraph",
                "upstream_base_url": LANGGRAPH_BASE_URL,
                "upstream_url": url,
                "method": method,
                "error": str(e),
                "hint_ru": "LangGraph недоступен. Запусти LangGraph (run.sh) или включи его в панели «Сервисы» (LangGraph).",
                "actions": [
                    {"type": "restart_langgraph", "endpoint": "/ui/restart-langgraph"},
                    {"type": "langgraph_start", "endpoint": "/ui/langgraph/start"},
                ],
            },
            status_code=502,
        )
    except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.TimeoutException) as e:
        return JSONResponse(
            {
                "ok": False,
                "error_type": "upstream_timeout",
                "service": "langgraph",
                "upstream_base_url": LANGGRAPH_BASE_URL,
                "upstream_url": url,
                "method": method,
                "error": str(e),
                "hint_ru": "Таймаут при обращении к LangGraph. Проверь, что LangGraph запущен и не завис, затем попробуй ещё раз.",
                "actions": [
                    {"type": "restart_langgraph", "endpoint": "/ui/restart-langgraph"},
                ],
            },
            status_code=504,
        )
    except httpx.RequestError as e:
        return JSONResponse(
            {
                "ok": False,
                "error_type": "upstream_request_error",
                "service": "langgraph",
                "upstream_base_url": LANGGRAPH_BASE_URL,
                "upstream_url": url,
                "method": method,
                "error": str(e),
                "hint_ru": "Ошибка запроса к LangGraph через UI Proxy. Проверь доступность LangGraph и повтори.",
            },
            status_code=502,
        )


    body = await request.body()

    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.request(method, url, headers=headers, content=body, params=dict(request.query_params))
        return Response(
            content=r.content,
            status_code=r.status_code,
            headers=dict(r.headers),
            media_type=r.headers.get("content-type"),
        )


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


@app.get("/ui/langgraph/status")
def ui_langgraph_status() -> Dict[str, Any]:
    return {
        "ok": True,
        "tmux_session": _tmux_has_session("langgraph"),
        "health": _langgraph_health(),
        "base_url": LANGGRAPH_BASE_URL,
    }


@app.post("/ui/langgraph/stop")
def ui_langgraph_stop() -> Dict[str, Any]:
    return _tmux_stop_langgraph()


@app.post("/ui/langgraph/start")
def ui_langgraph_start() -> Dict[str, Any]:
    return _tmux_start_langgraph()


@app.get("/ui/ui-proxy/status")
def ui_ui_proxy_status() -> Dict[str, Any]:
    # ui_proxy теперь управляется user systemd-сервисом
    svc = "my_langgraph_ui_proxy.service"
    active = False
    enabled = False
    err = ""
    try:
        r = subprocess.run(["systemctl", "--user", "is-active", svc], text=True, capture_output=True)
        active = (r.returncode == 0) and (r.stdout.strip() == "active")
        r2 = subprocess.run(["systemctl", "--user", "is-enabled", svc], text=True, capture_output=True)
        enabled = (r2.returncode == 0) and (r2.stdout.strip() == "enabled")
    except Exception as e:
        err = str(e)

    out = {
        "ok": True,
        "systemd_user_service": {"name": svc, "active": active, "enabled": enabled},
        "health": _http_health(f"http://{PROXY_HOST}:{PROXY_PORT}/health"),
        "base_url": f"http://{PROXY_HOST}:{PROXY_PORT}",
    }
    if err:
        out["systemd_user_service"]["error"] = err
    return out


@app.post("/ui/ui-proxy/start")
def ui_ui_proxy_start() -> Dict[str, Any]:
    svc = "my_langgraph_ui_proxy.service"
    try:
        r = subprocess.run(["systemctl", "--user", "start", svc], text=True, capture_output=True)
        if r.returncode != 0:
            return {"ok": False, "error": (r.stderr.strip() or r.stdout.strip() or "start failed")}
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/ui/ui-proxy/restart")
def ui_ui_proxy_restart() -> Dict[str, Any]:
    # Ответить до рестарта: делаем restart через задержку
    svc = "my_langgraph_ui_proxy.service"
    subprocess.Popen(
        ["bash", "-lc", f"sleep 0.2; systemctl --user restart {svc}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return {"ok": True}


@app.post("/ui/ui-proxy/stop")
def ui_ui_proxy_stop() -> Dict[str, Any]:
    # Ответить до остановки: делаем stop через задержку
    svc = "my_langgraph_ui_proxy.service"
    subprocess.Popen(
        ["bash", "-lc", f"sleep 0.2; systemctl --user stop {svc}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return {"ok": True}


@app.get("/ui/react-ui/status")
def ui_react_ui_status() -> Dict[str, Any]:
    svc = "my_langgraph_react_ui.service"
    active = False
    enabled = False
    err = ""
    try:
        r = subprocess.run(["systemctl", "--user", "is-active", svc], text=True, capture_output=True)
        active = (r.returncode == 0) and (r.stdout.strip() == "active")
        r2 = subprocess.run(["systemctl", "--user", "is-enabled", svc], text=True, capture_output=True)
        enabled = (r2.returncode == 0) and (r2.stdout.strip() == "enabled")
    except Exception as e:
        err = str(e)

    out = {
        "ok": True,
        "systemd_user_service": {"name": svc, "active": active, "enabled": enabled},
        "health": _http_health("http://127.0.0.1:5175/"),
        "base_url": "http://127.0.0.1:5175",
    }
    if err:
        out["systemd_user_service"]["error"] = err
    return out




@app.get("/ui/react-ui/logs")
def ui_react_ui_logs(lines: int = 200) -> Dict[str, Any]:
    """
    Логи React UI (systemd user service: my_langgraph_react_ui.service).
    Нужны, чтобы видеть ошибки сборки Vite/Babel и падения dev-сервера даже когда UI не загрузился.
    """
    return _systemd_user_journal("my_langgraph_react_ui.service", lines=lines)



@app.post("/ui/probe-tool-calls")
def ui_probe_tool_calls(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    payload: { "model": "...", "force": false }
    """
    model = str(payload.get("model", "")).strip()
    force = bool(payload.get("force", False))
    if not model:
        return JSONResponse({"ok": False, "error": "model пустой"}, status_code=400)

    now = time.time()
    cached = _PROBE_CACHE.get(model)
    if (not force) and cached and (now - float(cached.get("ts", 0.0))) < PROBE_CACHE_TTL_SECONDS:
        raw = dict(cached.get("raw") or {})
        raw["cached"] = True
        return raw

    res = probe_tool_calls.invoke({"model": model})
    out = dict(res)
    out["cached"] = False
    _PROBE_CACHE[model] = {"ok": bool(res.get("supports_tool_calls")), "ts": now, "raw": out}
    return out


@app.post("/ui/probe-all-tool-calls")
def ui_probe_all_tool_calls(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    payload: { "max_models": 6 }
    """
    max_models = int(payload.get("max_models", 6) or 6)
    max_models = max(1, min(40, max_models))

    res = probe_all_models_tool_calls.invoke({"max_models": max_models})
    out = dict(res)
    out["max_models"] = max_models
    return out
