#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/my_langgraph_agent"
AGENT_DIR="$ROOT/agent"
UI_DIR="$ROOT/ui"
VENV_ACTIVATE="$ROOT/venv/bin/activate"

LANGGRAPH_HOST="127.0.0.1"
LANGGRAPH_PORT="2024"

UI_PROXY_HOST="127.0.0.1"
UI_PROXY_PORT="8090"

REACT_HOST="127.0.0.1"
REACT_PORT="5174"

# сколько ждать готовности ui_proxy (сек)
UI_PROXY_WAIT_SECONDS="${UI_PROXY_WAIT_SECONDS:-15}"

if [[ ! -d "$ROOT" ]]; then
  echo "ERROR: папка $ROOT не найдена"
  exit 1
fi

if [[ ! -f "$VENV_ACTIVATE" ]]; then
  echo "ERROR: venv не найден: $VENV_ACTIVATE"
  exit 1
fi

# helper: wait for ui_proxy health
wait_ui_proxy() {
  local url="http://$UI_PROXY_HOST:$UI_PROXY_PORT/health"
  local start_ts now_ts elapsed
  start_ts="$(date +%s)"

  # curl может отсутствовать/ломаться — но у нас он есть (ты им уже пользовался)
  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    now_ts="$(date +%s)"
    elapsed=$((now_ts - start_ts))
    if (( elapsed >= UI_PROXY_WAIT_SECONDS )); then
      echo "WARN: ui_proxy не отвечает на $url за ${UI_PROXY_WAIT_SECONDS}s (React UI может увидеть ECONNREFUSED при старте)"
      return 1
    fi
    sleep 0.2
  done
}

# 1) LangGraph server in tmux
if ! tmux has-session -t langgraph 2>/dev/null; then
  tmux new -d -s langgraph "cd '$AGENT_DIR' && source '$VENV_ACTIVATE' && langgraph dev --no-browser"
  echo "Запущено: tmux session langgraph"
else
  echo "Уже запущено: tmux session langgraph"
fi

# 2) UI Proxy in tmux (единая точка входа для /api/* и /ui/*)
if ! tmux has-session -t ui_proxy 2>/dev/null; then
  tmux new -d -s ui_proxy "cd '$AGENT_DIR' && source '$VENV_ACTIVATE' && UI_PROXY_PORT='$UI_PROXY_PORT' python -m uvicorn react_agent.ui_proxy:app --host '$UI_PROXY_HOST' --port '$UI_PROXY_PORT'"
  echo "Запущено: tmux session ui_proxy"
else
  echo "Уже запущено: tmux session ui_proxy"
fi

# дождаться готовности ui_proxy перед стартом React UI (устраняет ECONNREFUSED на холодном старте)
wait_ui_proxy || true

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
echo "LangGraph API:     http://$LANGGRAPH_HOST:$LANGGRAPH_PORT"
echo "LangGraph Docs:    http://$LANGGRAPH_HOST:$LANGGRAPH_PORT/docs"
echo "UI Proxy:          http://$UI_PROXY_HOST:$UI_PROXY_PORT"
echo "React UI:          http://$REACT_HOST:$REACT_PORT"
echo
echo "Подсказка: логи: tmux attach -t <сессия> (выйти: Ctrl+B затем D)"
