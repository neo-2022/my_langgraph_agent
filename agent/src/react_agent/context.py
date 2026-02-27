"""Define the configurable parameters for the agent."""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field, fields
from typing import Annotated, List

from . import prompts


def _get_ollama_models() -> List[str]:
    """Return installed Ollama model names (always up-to-date).

    Parses `ollama list` output. If Ollama is unavailable, returns an empty list.
    """
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
    if not lines:
        return []

    # Expected header: NAME ID SIZE MODIFIED
    # We take the first column from each following line.
    models: List[str] = []
    for ln in lines[1:]:
        parts = ln.split()
        if not parts:
            continue
        name = parts[0].strip()
        if name and name.upper() != "NAME":
            models.append(name)
    return models


@dataclass(kw_only=True)
class Context:
    """The context for the agent."""

    system_prompt: str = field(
        default=prompts.SYSTEM_PROMPT,
        metadata={
            "description": "The system prompt to use for the agent's interactions. "
            "This prompt sets the context and behavior for the agent."
        },
    )

    # Model used by our ChatOllama in graph.py
    # You can override via env var MODEL, e.g.:
    #   export MODEL=qwen2.5-coder:14b
    model: Annotated[str, {"__template_metadata__": {"kind": "llm"}}] = field(
        default="qwen2.5-coder:14b",
        metadata={
            "description": "Ollama model name (must exist in `ollama list`), e.g. qwen2.5-coder:14b."
        },
    )

    # Always актуальный список установленных моделей Ollama (обновляется при старте сервера)
    available_models: List[str] = field(
        default_factory=list,
        metadata={
            "description": "Auto-detected installed Ollama models from `ollama list`."
        },
    )

    max_search_results: int = field(
        default=10,
        metadata={
            "description": "The maximum number of search results to return for each search query."
        },
    )

    def __post_init__(self) -> None:
        """Fetch env vars for attributes that were not passed as args."""
        for f in fields(self):
            if not f.init:
                continue
            if getattr(self, f.name) == f.default:
                setattr(self, f.name, os.environ.get(f.name.upper(), f.default))

        # Detect installed models from Ollama every time context is created.
        self.available_models = _get_ollama_models()

        # Safety: if the chosen model isn't installed, fall back to first available.
        if self.available_models and self.model not in self.available_models:
            self.model = self.available_models[0]
