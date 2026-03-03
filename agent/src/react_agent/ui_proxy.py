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

import logging
import os
import shlex
import sqlite3
import subprocess
import tempfile
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile
from starlette.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from react_agent.context import Context
from react_agent.obs_models import RawEventModel
from react_agent.spool import spool
from react_agent.tools import probe_tool_calls, probe_all_models_tool_calls


LANGGRAPH_BASE_URL = os.environ.get("LANGGRAPH_BASE_URL", "http://127.0.0.1:2024")
ART_INGEST_URL = os.environ.get("ART_INGEST_URL", "http://127.0.0.1:7331/api/v1/ingest")
ART_CONNECT_TIMEOUT = float(os.environ.get("ART_CONNECT_TIMEOUT", "3"))
ART_READ_TIMEOUT = float(os.environ.get("ART_READ_TIMEOUT", "10"))
ART_WRITE_TIMEOUT = float(os.environ.get("ART_WRITE_TIMEOUT", "10"))
PROXY_HOST = os.environ.get("UI_PROXY_HOST", "127.0.0.1")
PROXY_PORT = int(os.environ.get("UI_PROXY_PORT", "8090"))
CLIENT_ID_KEY = "UI_CLIENT_ID"
INGEST_BEARER_TOKEN = os.environ.get("REGART_INGEST_TOKEN", "")
PROVIDER_DEFAULT_BASE = os.environ.get("PROVIDER_BASE_URL", "http://127.0.0.1:9555/provider")
PROVIDER_CONNECT_TIMEOUT = float(os.environ.get("PROVIDER_CONNECT_TIMEOUT", "3"))
PROVIDER_READ_TIMEOUT = float(os.environ.get("PROVIDER_READ_TIMEOUT", "10"))
PROVIDER_WRITE_TIMEOUT = float(os.environ.get("PROVIDER_WRITE_TIMEOUT", "10"))

CORRELATION_HEADER_NAMES = ("x-trace-id", "x-span-id", "x-request-id")
ALLOWED_ATTACHMENT_MIME = {
    "image/png",
    "image/jpeg",
    "text/plain",
    "application/json",
}
ATTACHMENT_MAGIC_SIGNATURES: Dict[str, List[bytes]] = {
    "image/png": [b"\x89PNG\r\n\x1a\n"],
    "image/jpeg": [b"\xff\xd8\xff"],
    "application/json": [b"{", b"["],
}
MAX_ATTACHMENT_BYTES = int(os.environ.get("ATTACHMENT_MAX_BYTES", str(5_242_880)))
ATTACHMENT_SCANNER_CMD = os.environ.get("ATTACHMENT_SCANNER_CMD", "").strip()

REDACT_SENSITIVE_KEYS = {
    "authorization",
    "api_key",
    "client_secret",
    "credentials",
    "password",
    "refresh_token",
    "secret",
    "token",
    "access_token",
}
REDACTED_MARKER = "***REDACTED***"


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

logger = logging.getLogger(__name__)


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


def _ensure_client_id() -> str:
    existing = _get_env_key(CLIENT_ID_KEY)
    if existing:
        return existing
    new_id = uuid.uuid4().hex
    _set_env_key(CLIENT_ID_KEY, new_id)
    return new_id


def _build_ingest_allowlist() -> Set[str]:
    raw = os.environ.get("REGART_INGEST_CLIENT_IDS", "").strip()
    ids = {part.strip() for part in raw.split(",") if part.strip()}
    if ids:
        return ids
    return {_ensure_client_id()}


ALLOWED_INGEST_CLIENT_IDS = _build_ingest_allowlist()


def _authorize_ingest(request: Request) -> str:
    header = request.headers.get("authorization") or request.headers.get("Authorization")
    if not header or not header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Bearer token required")
    token = header.split(" ", 1)[1]
    if not INGEST_BEARER_TOKEN:
        raise HTTPException(status_code=503, detail="Ingest token not configured")
    if token != INGEST_BEARER_TOKEN:
        raise HTTPException(status_code=403, detail="invalid ingest token")

    client_id = request.headers.get("x-client-id") or request.headers.get("X-Client-Id")
    if not client_id:
        raise HTTPException(status_code=403, detail="client id required")
    if client_id not in ALLOWED_INGEST_CLIENT_IDS:
        raise HTTPException(status_code=403, detail="client id is not allowlisted")
    return client_id


def _results_retry(events: Iterable[Dict[str, Any]], reason: str) -> List[Dict[str, Any]]:
    return [
        {
            "event_id": ev.get("event_id"),
            "status": "retryable",
            "reason": reason,
        }
        for ev in events
    ]


async def _spool_events(events: Iterable[Dict[str, Any]], client_id: str, reason: str) -> None:
    try:
        await spool.add_events(events, client_id)
    except sqlite3.DatabaseError as exc:
        logger.exception("spool failure during snapshot: %s", exc)


def _collect_correlation_headers(request: Request) -> Dict[str, str]:
    headers: Dict[str, str] = {}
    for name in CORRELATION_HEADER_NAMES:
        value = request.headers.get(name)
        if value:
            headers[name] = value
    return headers


def _is_sensitive_key(name: Optional[str]) -> bool:
    return bool(name and name.lower() in REDACT_SENSITIVE_KEYS)


def _redact_sensitive_value(value: Any, name: Optional[str] = None) -> Any:
    if _is_sensitive_key(name):
        return REDACTED_MARKER
    if isinstance(value, dict):
        return {k: _redact_sensitive_value(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_sensitive_value(item) for item in value]
    return value


def _redact_event(raw: Dict[str, Any]) -> Dict[str, Any]:
    return _redact_sensitive_value(raw)


def _is_safe_filename(name: Optional[str]) -> bool:
    if not name:
        return False
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or normalized.startswith(".."):  # absolute or starts with parent
        return False
    if ".." in normalized.split("/"):
        return False
    return os.path.basename(normalized) == normalized


def _matches_magic_bytes(content: bytes, mime: str) -> bool:
    signatures = ATTACHMENT_MAGIC_SIGNATURES.get(mime)
    if not signatures:
        return True
    return any(content.startswith(sig) for sig in signatures)


def _describe_attachment(filename: str, mime: str, size: int) -> Dict[str, Any]:
    return {
        "filename": filename,
        "mime": mime,
        "size": size,
        "render_mode": "download-only",
    }


def _scan_attachment(content: bytes) -> Tuple[bool, Optional[str]]:
    cmd = os.environ.get("ATTACHMENT_SCANNER_CMD", "").strip()
    if not cmd:
        return True, None

    args = shlex.split(cmd)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp.write(content)
            tmp.flush()
            tmp_path = tmp.name
        proc = subprocess.run(
            args + ([tmp_path] if tmp_path else []),
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception as exc:
        logger.warning("attachment scanner error: %s", exc)
        return True, None
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    if proc.returncode == 0:
        return True, None
    if proc.returncode == 1:
        message = (proc.stdout or proc.stderr or "malware detected").strip()
        return False, message
    logger.warning(
        "attachment scanner unexpected returncode=%s stdout=%s stderr=%s",
        proc.returncode,
        proc.stdout,
        proc.stderr,
    )
    return True, None


def _run_attachment_scanner_update(cmd: str) -> Tuple[bool, str]:
    args = shlex.split(cmd)
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except Exception as exc:
        logger.warning("attachment scanner update failed: %s", exc)
        return False, str(exc)

    output = (proc.stdout or proc.stderr or "").strip()
    if proc.returncode == 0:
        return True, output or "update succeeded"
    message = output or f"update failed ({proc.returncode})"
    return False, message


async def _maybe_move_to_dlq(results: List[Dict[str, Any]], events: Iterable[Dict[str, Any]], client_id: str) -> None:
    mapping: Dict[str, Dict[str, Any]] = {}
    for ev in events:
        eid = ev.get("event_id")
        if isinstance(eid, str):
            mapping[eid] = ev
    moved = 0
    for ack in results:
        status = str(ack.get("status", "")).lower()
        if status in ("rejected", "invalid", "permanent"):
            event_id = ack.get("event_id")
            raw_event = mapping.get(event_id)
            if raw_event:
                await spool.move_to_dlq(
                    event_id, client_id, raw_event, ack.get("reason", "rejected"), ack.get("attempts", 0)
                )
                moved += 1
    if moved:
        logger.warning("observability_gap.dlq_non_empty: %s events moved to DLQ", moved)


def _build_art_timeout() -> httpx.Timeout:
    return httpx.Timeout(
        timeout=None,
        connect=ART_CONNECT_TIMEOUT,
        read=ART_READ_TIMEOUT,
        write=ART_WRITE_TIMEOUT,
    )


def _build_art_envelope(events: List[Dict[str, Any]], client_id: str) -> Dict[str, Any]:
    return {
        "source": {
            "id": client_id,
            "type": "regart.ui",
            "hostname": PROXY_HOST,
            "version": "ui-proxy-0.3.0",
        },
        "events": events,
    }


async def _forward_to_art(
    events: List[Dict[str, Any]],
    client_id: str,
    correlation_headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    if not events:
        return {"ok": True, "results": []}
    envelope = _build_art_envelope(events, client_id)
    async with httpx.AsyncClient(timeout=_build_art_timeout()) as client:
        headers = {"X-Client-Id": client_id}
        if correlation_headers:
            headers.update(correlation_headers)
        response = await client.post(ART_INGEST_URL, json=envelope, headers=headers)
        response.raise_for_status()
        return response.json()


def _get_provider_transport_mode() -> str:
    return os.environ.get("PROVIDER_TRANSPORT_MODE", "providers").lower()


def _get_provider_base_url() -> str:
    return os.environ.get("PROVIDER_BASE_URL", PROVIDER_DEFAULT_BASE).rstrip("/")


def _build_provider_timeout() -> httpx.Timeout:
    return httpx.Timeout(
        timeout=None,
        connect=PROVIDER_CONNECT_TIMEOUT,
        read=PROVIDER_READ_TIMEOUT,
        write=PROVIDER_WRITE_TIMEOUT,
    )


def _log_provider_event(kind: str, provider_id: str, client_id: str, mode: str, extra: Optional[Dict[str, Any]] = None) -> None:
    info = {
        "provider_id": provider_id,
        "client_id": client_id,
        "mode": mode,
    }
    if extra:
        info.update(extra)
    logger.info("provider.%s %s", kind, info)


async def _forward_to_provider(
    provider_id: str,
    payload: Dict[str, Any],
    client_id: str,
    correlation_headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    mode = _get_provider_transport_mode()
    _log_provider_event("request", provider_id, client_id, mode, {"payload_keys": list(payload.keys())})
    try:
        if mode == "art":
            logger.info("observability_gap.provider_transport_switch: %s -> art", provider_id)
            response = await _forward_to_art(payload.get("events", []), client_id, correlation_headers)
            _log_provider_event("response", provider_id, client_id, mode, {"status": response.get("ok")})
            return response

        url = f"{_get_provider_base_url()}/{provider_id}"
        async with httpx.AsyncClient(timeout=_build_provider_timeout()) as client:
            headers = {"X-Client-Id": client_id}
            if correlation_headers:
                headers.update(correlation_headers)
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            body = response.json()
            _log_provider_event("response", provider_id, client_id, mode, {"status": response.status_code})
            return body
    except httpx.TimeoutException as exc:
        logger.warning("observability_gap.provider_timeout: %s", exc)
        raise HTTPException(status_code=504, detail="provider timeout") from exc
    except httpx.RequestError as exc:
        logger.warning("observability_gap.provider_request_error: %s", exc)
        raise HTTPException(status_code=502, detail="provider request error") from exc


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


@app.get("/ui/client-info")
def ui_client_info() -> Dict[str, Any]:
    """
    Безопасный (non-secret) идентификатор клиента REGART.
    """
    return {
        "ok": True,
        "client_id": _ensure_client_id(),
        "proxy_host": PROXY_HOST,
        "proxy_port": PROXY_PORT,
    }


@app.post("/ui/art/ingest")
async def ui_art_ingest(request: Request, payload: Dict[str, Any]) -> Dict[str, Any]:
    client_id = request.headers.get("x-client-id") or _ensure_client_id()
    events = payload.get("events")
    if not isinstance(events, list):
        raise HTTPException(status_code=400, detail="events must be a list")

    correlation_headers = _collect_correlation_headers(request)

    try:
        response = await _forward_to_art(events, client_id, correlation_headers)
        results = response.get("results")
        if not isinstance(results, list):
            results = [
                {
                    "event_id": event.get("event_id"),
                    "status": "accepted",
                }
                for event in events
            ]
        payload_ack = {
            "ok": response.get("ok", True),
            "accepted": response.get("accepted"),
            "retry_after_ms": response.get("retry_after_ms"),
            "results": results,
        }
        await _maybe_move_to_dlq(results, events, client_id)
        return payload_ack
    except httpx.TimeoutException as exc:
        await _spool_events(events, client_id, "art_timeout")
        return JSONResponse(
            {
                "ok": False,
                "error": "upstream_timeout",
                "reason": str(exc),
                "results": _results_retry(events, "art_timeout"),
                "retry_after_ms": 1000,
            },
            status_code=504,
        )
    except httpx.RequestError as exc:
        await _spool_events(events, client_id, "art_request_error")
        return JSONResponse(
            {
                "ok": False,
                "error": "upstream_error",
                "reason": str(exc),
                "results": _results_retry(events, "art_request_error"),
            },
            status_code=502,
        )


@app.post("/ui/provider/{provider_id}")
async def ui_provider_call(provider_id: str, request: Request, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    client_id = request.headers.get("x-client-id") or _ensure_client_id()
    correlation_headers = _collect_correlation_headers(request)
    return await _forward_to_provider(provider_id, payload or {}, client_id, correlation_headers)


@app.post("/ui/ingest/events")
async def ui_ingest_events(request: Request, payload: Dict[str, Any]) -> Dict[str, Any]:
    client_id = _authorize_ingest(request)
    events = payload.get("events")
    if not isinstance(events, list):
        events = []
    validated: List[RawEventModel] = []
    redacted_events = []

    for idx, candidate in enumerate(events):
        try:
            model = RawEventModel.model_validate(candidate or {})
        except ValidationError as exc:
            logger.warning(
                "ui_ingest_events: validation failed idx=%s client=%s errors=%s",
                idx,
                client_id,
                exc.errors(),
            )
            raise HTTPException(
                status_code=422,
                detail={"index": idx, "errors": exc.errors()},
            )
        validated.append(model)
        redacted_events.append(_redact_event(model.model_dump()))

    logger.info(
        "ui_ingest_events: client=%s received=%s validated=%s",
        client_id,
        len(events),
        len(validated),
    )
    return {
        "ok": True,
        "received": len(events),
        "validated": len(validated),
        "client_id": client_id,
        "redacted_events": redacted_events,
    }


@app.post("/ui/ingest/attachments")
async def ui_ingest_attachments(request: Request) -> Dict[str, Any]:
    client_id = _authorize_ingest(request)
    form = await request.form()
    uploads: List[UploadFile] = [value for value in form.values() if isinstance(value, UploadFile)]
    attachments: List[Dict[str, Any]] = []

    for upload in uploads:
        filename = upload.filename or "attachment"
        if not _is_safe_filename(filename):
            logger.warning("observability_gap.attachment_bad_filename: %s", filename)
            raise HTTPException(status_code=400, detail="filename contains unsafe segments")

        mime = (upload.content_type or "application/octet-stream").lower()
        if mime not in ALLOWED_ATTACHMENT_MIME:
            logger.warning("observability_gap.attachment_bad_mime: %s", mime)
            raise HTTPException(status_code=400, detail=f"unsupported mime type: {mime}")

        content = await upload.read()
        await upload.close()
        size = len(content)
        if size > MAX_ATTACHMENT_BYTES:
            logger.warning("observability_gap.attachment_too_large: %s size=%s", filename, size)
            raise HTTPException(status_code=413, detail="attachment exceeds max size")

        clean, reason = _scan_attachment(content)
        if not clean:
            logger.warning("observability_gap.attachment_malware_detected: %s reason=%s", filename, reason)
            raise HTTPException(status_code=400, detail="attachment flagged as malware")
        if not _matches_magic_bytes(content, mime):
            logger.warning("observability_gap.attachment_magic_mismatch: %s", filename)
            raise HTTPException(status_code=400, detail="attachment content signature mismatch")

        attachments.append(_describe_attachment(filename, mime, size))

    return {
        "ok": True,
        "client_id": client_id,
        "attachments": attachments,
        "files": len(attachments),
    }


@app.api_route("/ui/attachments/update-scanner", methods=["GET", "POST"])
async def ui_update_attachment_scanner() -> Dict[str, Any]:
    cmd = os.environ.get("ATTACHMENT_SCANNER_UPDATE_CMD", "").strip()
    if not cmd:
        raise HTTPException(status_code=404, detail="scanner update not configured")

    ok, msg = _run_attachment_scanner_update(cmd)
    if not ok:
        raise HTTPException(status_code=500, detail=msg)

    return {"ok": True, "message": msg}


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
