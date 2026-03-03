# my_langgraph_agent

Репозиторий для локального LangGraph-агента + React UI.

---
## Запуск (systemd user services)

Скрипт `run.sh` копирует сервисы из `systemd/*.service` в `~/.config/systemd/user/`, перезапускает systemd-демон и включает+стартует три пользователя-сервиса (`my_langgraph.service`, `my_langgraph_ui_proxy.service`, `my_langgraph_react_ui.service`).

```bash
cd ~/my_langgraph_agent
./run.sh
```

Каждый сервис может быть контролирован вручную через `systemctl --user start|stop|restart <имя>` и `systemctl --user status <имя>`. Команды `journalctl --user -u <имя>` показывают логи.

Если LangGraph запускается с сервисом отличным от `LangGraph.service` (например, `my_langgraph.service`), выставьте:

```bash
export LANGGRAPH_SYSTEMD_SERVICE=my_langgraph.service
```

UI Proxy уже экспортирует `LANGGRAPH_SYSTEMD_SERVICE=my_langgraph.service`, поэтому кнопка «Перезапустить LangGraph сервер» работает через systemd и повторно запускает именно `my_langgraph.service`. Если нужно переопределить имя сервиса — выставь переменную до запуска UI Proxy (в `~/.bashrc`, `~/.profile` или `.env`) и перезапусти `my_langgraph_ui_proxy.service`.

UI Proxy (`my_langgraph_ui_proxy.service`) и React UI (`my_langgraph_react_ui.service`) тоже ожидаются как systemd-сервисы; `run.sh` устанавливает и включают их автоматически. При необходимости можно самостоятельно выполнить:

```bash
systemctl --user enable --now my_langgraph_ui_proxy.service
systemctl --user enable --now my_langgraph_react_ui.service
```

UI Proxy также проксирует SSE downlink `/ui/art/stream` к `ART_STREAM_URL` (по умолчанию `http://127.0.0.1:7331/api/v1/stream`). Укажи нужный URL через переменную окружения `ART_STREAM_URL`, если Art смотрит на другой адрес.

LangGraph, UI Proxy и React UI всегда запускаются как user systemd-сервисы — `tmux` больше не нужен. Если тебе нужно управлять нестандартным сервисом, пропиши `export LANGGRAPH_SYSTEMD_SERVICE=имя_сервиса` в окружении (`~/.bashrc`, `~/.profile` или `.env`, откуда стартует UI Proxy), чтобы кнопка «Перезапустить LangGraph сервер» и ручные `/ui/langgraph/{start,stop}` отправляли команды нужному systemd-сервису.

После этого UI (включая кнопку «Перезапустить LangGraph сервер» и `/ui/langgraph/{start,stop}`) работает через этот сервис.

----
## React UI: Split View и Graph

- Режим Split View запоминает ширину панелей и позволяет перетаскивать делитель: левая и правая панели меняют ширину, а последнее значение хранится в `localStorage`.
- Вкладка Graph сохраняет пользовательские положения нод по `assistant_id` в `localStorage` и повторно использует их при переключении вкладок/перезагрузке, поэтому вручную смещённые элементы останутся на месте.

## Как выбрать модель Ollama (через React UI)

1) Открой React UI: http://127.0.0.1:5174  
2) Панель “Локальные модели (Ollama)” → выбери модель → “Сохранить”  
3) (Если нужно) “Перезапустить LangGraph”  
4) Обнови страницу

---

## Структура проекта (важное)

- `agent/` — LangGraph проект (Python)
- `ui/` — React UI (Vite)
- `ui/src/debugger/` — модуль сквозного Debugger (реализация Level 0/Level 1 в UI)
- `run.sh` — запуск всего одной командой

Документация:
- `CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md` — единый источник правды по UI/Graph/Run/Debugger
- `ui/src/debugger/README.md` — подробная спецификация сквозного Debugger (фон + панель + события + корреляция)

## Сквозной Debugger (UI/Run/Graph/Models/Tools/Network)
- Единый слой ошибок для всего интерфейса: Run stream / API / UI proxy / Graph / Models / Tools / React.
- См. подробную спецификацию: `ui/src/debugger/README.md`.
- Нормализация ошибок в формат UiError (scope/severity/title/message/details/ctx/dedupe/actions).
- Отображение: глобальный индикатор + drawer “Ошибки”, без спама (dedupe/throttle).
- Действия: copy details, переход к контексту (run_id/node_id/span_id), retry, restart LangGraph, reload.
- Спецификация и Definition of Done: см. `CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md`, раздел 1.0.

- `TASKS.md` — трекер прогресса (по чеклисту)
- `ROADMAP.md` — план “что и зачем” (по этапам)

---

## Как продолжать работу в новом чате

Если чат будет новый, начни так:
- “Продолжаем проект my_langgraph_agent”
- “Текущая задача: …”

(по желанию) вставь вывод:

~~~bash
cd ~/my_langgraph_agent
git status -sb
git log -1 --oneline
~~~

---

## Полезные файлы UI

- `ui/src/App.jsx` — центральная сборка UI (вкладки, SplitView, Run)
- `ui/src/GraphView.jsx` — отрисовка графа
- `ui/src/SplitView.jsx` — split UX
- `ui/src/debugger/core.js` — Level 1 core (адаптер к Level 0)
- `ui/src/debugger/level0.js` — Level 0 (bootstrap, source of truth)
- `agent/src/react_agent/ui_proxy.py` — UI Proxy (эндпоинты /ui/*)
- `scripts/verify_integrity.py` — gate-проверки инвариантов
- `scripts/safe_edit.py` — безопасные правки файлов
