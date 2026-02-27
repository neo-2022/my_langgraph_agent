#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/my_langgraph_agent"
AGENT_DIR="$ROOT/agent"
UI_DIR="$ROOT/ui"
VENV_ACTIVATE="$ROOT/venv/bin/activate"

LANGGRAPH_PORT="2024"
SETTINGS_PORT="8088"
REACT_HOST="127.0.0.1"
REACT_PORT="5174"

if [[ ! -d "$ROOT" ]]; then
  echo "ERROR: папка $ROOT не найдена"
  exit 1
fi

if [[ ! -f "$VENV_ACTIVATE" ]]; then
  echo "ERROR: venv не найден: $VENV_ACTIVATE"
  exit 1
fi

# 1) LangGraph server in tmux
if ! tmux has-session -t langgraph 2>/dev/null; then
  tmux new -d -s langgraph "cd '$AGENT_DIR' && source '$VENV_ACTIVATE' && langgraph dev --no-browser"
  echo "Запущено: tmux session langgraph"
else
  echo "Уже запущено: tmux session langgraph"
fi

# 2) Settings UI in tmux
if ! tmux has-session -t settings_ui 2>/dev/null; then
  tmux new -d -s settings_ui "cd '$AGENT_DIR' && source '$VENV_ACTIVATE' && python -m react_agent.settings_app"
  echo "Запущено: tmux session settings_ui"
else
  echo "Уже запущено: tmux session settings_ui"
fi

# 3) React UI in tmux
if [[ -d "$UI_DIR" ]]; then
  if ! tmux has-session -t ui 2>/dev/null; then
    tmux new -d -s ui "cd '$UI_DIR' && npm run dev -- --host $REACT_HOST --port $REACT_PORT"
    echo "Запущено: tmux session ui"
  else
    echo "Уже запущено: tmux session ui"
  fi
else
  echo "UI папка не найдена ($UI_DIR) — пропускаю запуск React UI"
fi

echo
echo "LangGraph API:     http://127.0.0.1:$LANGGRAPH_PORT"
echo "LangGraph Docs:    http://127.0.0.1:$LANGGRAPH_PORT/docs"
echo "Settings UI:       http://127.0.0.1:$SETTINGS_PORT"
echo "React UI:          http://$REACT_HOST:$REACT_PORT"
echo
echo "Подсказка: логи: tmux attach -t <сессия> (выйти: Ctrl+B затем D)"
