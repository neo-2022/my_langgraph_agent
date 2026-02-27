"""Local tools for the agent (Ollama-focused, no cloud deps).

Goal:
- Provide a dynamic list of installed Ollama models
- Allow selecting a model and persisting it (via .env: MODEL=...)
- Probe whether a model supports proper tool calling (tool_calls)
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from langchain_core.tools import tool
from langchain_ollama import ChatOllama


def _run_ollama_list() -> List[str]:
    """Return installed Ollama model names by parsing `ollama list`."""
    try:
        proc = subprocess.run(
            ["ollama", "list"],
            check=False,
            capture_output=True,
            text=True,
        )
    except Exception:
        return []

    if proc.returncode != 0:
        return []

    lines = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]
    if len(lines) < 2:
        return []

    models: List[str] = []
    for ln in lines[1:]:
        parts = ln.split()
        if parts:
            models.append(parts[0])
    return models


def _env_file_path() -> Path:
    # Project root is .../agent ; we keep .env here
    return Path(__file__).resolve().parents[2] / ".env"


def _upsert_env_var(path: Path, key: str, value: str) -> None:
    """Upsert KEY=VALUE in a .env file (preserve other lines)."""
    key_prefix = f"{key}="
    if path.exists():
        lines = path.read_text(encoding="utf-8").splitlines()
    else:
        lines = []

    out: List[str] = []
    found = False
    for ln in lines:
        if ln.startswith(key_prefix):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(ln)

    if not found:
        out.append(f"{key}={value}")

    path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")


@tool
def list_ollama_models() -> Dict[str, Any]:
    """List installed Ollama models (always current).

    Returns:
      { "models": [...], "current": "<MODEL env or empty>" }
    """
    models = _run_ollama_list()
    current = os.environ.get("MODEL", "")
    return {"models": models, "current": current}


@tool
def set_ollama_model(model: str) -> Dict[str, Any]:
    """Select an Ollama model and persist it into .env as MODEL=<name>.

    Notes:
    - This does NOT hot-swap the already-running server context everywhere.
      It persists the choice so that the next server start uses it by default.
    """
    models = _run_ollama_list()
    if not models:
        return {"ok": False, "error": "No Ollama models found (ollama list is empty)."}

    if model not in models:
        return {
            "ok": False,
            "error": "Model not installed.",
            "requested": model,
            "available": models,
        }

    env_path = _env_file_path()
    _upsert_env_var(env_path, "MODEL", model)

    # Also set for this process (best-effort)
    os.environ["MODEL"] = model

    return {"ok": True, "model": model, "env_file": str(env_path)}


def _probe_tool_calls_single(model: str, timeout_sec: int = 30) -> Dict[str, Any]:
    """Internal helper: check whether model produces real tool_calls."""
    try:
        llm = ChatOllama(model=model, timeout=timeout_sec).bind_tools([list_ollama_models])
        msg = llm.invoke("Вызови инструмент list_ollama_models и ничего больше не пиши.")
        tool_calls = getattr(msg, "tool_calls", None) or []
        supports = len(tool_calls) > 0
        return {
            "model": model,
            "supports_tool_calls": supports,
            "tool_calls_count": len(tool_calls),
        }
    except Exception as e:
        return {
            "model": model,
            "supports_tool_calls": False,
            "tool_calls_count": 0,
            "error": repr(e),
        }


@tool
def probe_tool_calls(model: str) -> Dict[str, Any]:
    """Check if a given Ollama model supports proper tool calling.

    Returns:
      {
        "model": "...",
        "supports_tool_calls": true/false,
        "tool_calls_count": N,
        "error": "...optional..."
      }
    """
    return _probe_tool_calls_single(model)


@tool
def probe_all_models_tool_calls(max_models: int = 6) -> Dict[str, Any]:
    """Probe tool-calling support across installed models.

    max_models:
      Limit how many models to test (safety: big models can be slow).

    Returns:
      { "tested": [...], "skipped": [...], "note": "..." }
    """
    models = _run_ollama_list()
    if not models:
        return {"tested": [], "skipped": [], "note": "No Ollama models found."}

    tested: List[Dict[str, Any]] = []
    skipped: List[str] = []
    for i, m in enumerate(models):
        if i >= max_models:
            skipped = models[i:]
            break
        tested.append(_probe_tool_calls_single(m))

    return {
        "tested": tested,
        "skipped": skipped,
        "note": "Increase max_models to test more, but big models may take longer.",
    }


TOOLS: List[Callable[..., Any]] = [
    list_ollama_models,
    set_ollama_model,
    probe_tool_calls,
    probe_all_models_tool_calls,
]
