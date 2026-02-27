#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/my_langgraph_agent"
AGENT_DIR="$ROOT/agent"
VENV_ACTIVATE="$ROOT/venv/bin/activate"

if [[ ! -d "$ROOT" ]]; then
  echo "ERROR: папка $ROOT не найдена"
  exit 1
fi

if [[ ! -f "$VENV_ACTIVATE" ]]; then
  echo "ERROR: venv не найден: $VENV_ACTIVATE"
  echo "Подсказка: создай venv в $ROOT/venv"
  exit 1
fi

# LangGraph server in tmux
if ! tmux has-session -t langgraph 2>/dev/null; then
  tmux new -d -s langgraph "cd '$AGENT_DIR' && source '$VENV_ACTIVATE' && langgraph dev --no-browser"
  echo "Started tmux session: langgraph"
else
  echo "tmux session already exists: langgraph"
fi

# Settings UI in tmux
if ! tmux has-session -t settings_ui 2>/dev/null; then
  tmux new -d -s settings_ui "cd '$AGENT_DIR' && source '$VENV_ACTIVATE' && python -m react_agent.settings_app"
  echo "Started tmux session: settings_ui"
else
  echo "tmux session already exists: settings_ui"
fi

echo
echo "LangGraph API:     http://127.0.0.1:2024"
echo "LangGraph Docs:    http://127.0.0.1:2024/docs"
echo "Settings UI:       http://127.0.0.1:8088"
echo
echo "Tip: tmux attach -t langgraph   (detach: Ctrl+B then D)"
