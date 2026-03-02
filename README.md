# my_langgraph_agent

Репозиторий для локального LangGraph-агента + React UI.

## Запуск (tmux)
Запуск всего:
~~~bash
cd ~/my_langgraph_agent
./run.sh
~~~

Порты:
- UI: http://127.0.0.1:5174
- API Docs: http://127.0.0.1:2024/docs
- UI Proxy: http://127.0.0.1:8090

tmux:
- attach: `tmux attach -t <session>`
- dettach: `Ctrl+B` затем `D`

---

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

