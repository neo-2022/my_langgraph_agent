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
REACT_PORT="5175"

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

# 1) Install user systemd services
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SERVICES=(
  "my_langgraph.service"
  "my_langgraph_ui_proxy.service"
  "my_langgraph_react_ui.service"
  "my_langgraph_mock_art.service"
)

mkdir -p "$SYSTEMD_USER_DIR"
cp -f "$ROOT/systemd/"*.service "$SYSTEMD_USER_DIR/"

systemctl --user daemon-reload

for svc in "${SERVICES[@]}"; do
  systemctl --user enable --now "$svc"
done

echo
echo "LangGraph API:  http://$LANGGRAPH_HOST:$LANGGRAPH_PORT"
echo "LangGraph Docs: http://$LANGGRAPH_HOST:$LANGGRAPH_PORT/docs"
echo "UI Proxy:       http://$UI_PROXY_HOST:$UI_PROXY_PORT"
echo "React UI:       http://$REACT_HOST:$REACT_PORT"
echo "Mock Art:       http://127.0.0.1:7331/api/v1/stream"
