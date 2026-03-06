# ROADMAP — my_langgraph_agent

Этот файл — “план проекта” простыми словами: что уже сделано, где мы сейчас, что дальше и в каком порядке.

**Единый источник правды по UI/Graph/Run/Debugger:** `CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md`  
`TASKS.md` — трекер выполнения пунктов из чеклиста.

---

## 0) Цель проекта (куда идём)

Сделать **локального агента** на LangGraph, который:
- работает с **Ollama** (локальные модели)
- позже умеет подключать **облачные модели** (OpenAI/Anthropic и др.) **в отдельном окружении** (без конфликтов)
- поддерживает **инструменты** (файлы, shell, web-поиск)
- имеет **локальный интерфейс “как Studio”**:
  - Run (stream)
  - Graph (узлы/стрелки)
  - **Split View** (Run и Graph одновременно)
  - **Execution Journal** (отдельный журнал выполнения, не только messages)
  - подсветка активных узлов/веток во время stream
  - inspector узла + детали инструментов
  - state diff + таймлайны + метрики
  - breakpoints + continue/step/stop/restart

---

## 1) Что уже сделано (готово)

### 1.1 Окружение/инфра
- Создан проект в `~/my_langgraph_agent`
- `venv` (Python 3.12)
- зависимости приведены в порядок (в т.ч. protobuf)
- `run.sh` копирует systemd-сервисы и включает (enable+start) LangGraph/UI Proxy/React UI через `systemctl --user`

### 1.2 LangGraph агент
- LangGraph проект в `agent/`
- запуск: `langgraph dev --no-browser`
- агент использует **Ollama** (ChatOllama)

### 1.3 Tools (управление/диагностика)
- list/set модели Ollama
- probe tool_calls для модели/массово
- restart LangGraph через systemd-сервис (для применения настроек)

### 1.4 React UI (Vite)
- UI на `http://127.0.0.1:5175`
- базовый layout: rail + drawers + main tabs
- вкладка Run: stream, показ messages, tool_calls/tool results
- вкладка Graph: React Flow + Dagre layout + Controls/MiniMap
- SplitView (в процессе/частично)

### 1.5 UI Proxy
- единая точка входа: `http://127.0.0.1:8090`
- `/api/*` → LangGraph API `127.0.0.1:2024`
- `/ui/*` → endpoints управления локальными моделями/перезапуском (всё в ui_proxy)

---

## 2) Где мы сейчас (текущее состояние)

У нас есть:
- стабильный запуск сервисов
- Run работает (stream)
- Graph показывает структуру графа
- UI Proxy обслуживает и `/api/*`, и `/ui/*` (без отдельного Settings UI)

**Чего критично не хватает для отладки:**
- одновременно видеть Run и Graph (Split View)
- отдельный Execution Journal
- подсветка графа по stream
- подготовка контракта backend-событий (spans)

---

## 3) План работ (по этапам)

## Этап B2 — UI Debugger (Split View + Execution Journal)  ← делаем сейчас
Цель: “живой” интерфейс для отладки.


### B2.0 UI Error Debugger / обработчик ошибок (обязательный слой)
Зачем: чтобы любые ошибки в UI не “терялись” и показывались единообразно.

Что будет:
- единый формат UiError (scope/severity/title/message/details/ctx/dedupe/actions)
- глобальный индикатор + drawer “Ошибки”
- действия: copy details, переход к контексту, retry, restart LangGraph, reload

Спецификация: `CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md`, раздел 1.0.
- Подробная концепция сквозного Debugger: `ui/src/debugger/README.md`.


### B2.1 Split View (обязательно)
- 3 режима: Run only / Graph only / Split
- draggable splitter, ограничения min-width
- сохранение режима/ширины в localStorage
- навигация:
  - клик по событию в журнале → центрировать граф на ноде
  - клик по ноде → скроллить журнал к связанным событиям

### B2.2 Подсветка на графе во время stream (MVP)
Временно (пока нет backend span-событий) — извлекаем из текущих messages/tool_calls:
- active/running node
- done node
- error
- “долго выполняется” (>2s)

### B2.3 Execution Journal (UI) (MVP)
- отдельный список событий/таймлайн рядом с messages
- временное наполнение из messages/tool_calls
- контракт события фиксируем (см. CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md)

---

### Внешняя панель в трее (AppIndicator/StatusNotifier) — позже
Зачем: управление сервисами и диагностика **вне React UI**, чтобы можно было безопасно рестартить/стопать ui_proxy и видеть статусы даже если UI упал.
Ключевые требования зафиксированы в `TASKS.md` (Этап T).

## Этап B3 — Backend span-события (настоящий трейс)
Цель: перестать “угадывать” по messages, получать корректные события:
- node_start/node_end
- tool_start/tool_end
- edge_chosen
- span_id + parent_span_id
- порядок событий гарантирует сервер

---

## Этап B4 — Breakpoints + управление выполнением
Цель: отладка как в IDE:
- breakpoint toggle на ноде
- pause “перед узлом”
- Continue / Step (MVP=step over) / Stop / Restart (новый run)

---

## Этап C — Runs/Threads (история)
- список runs/threads
- открыть run → messages + journal + графовая подсветка (по событиям)
- rerun (повтор запуска)
- фильтры/поиск

---

## Этап D — State + diff + метрики
- state snapshots (MVP: top-level keys)
- diff (added/removed/updated)
- таймлайны узлов/tools
- метрики: медленные узлы, счётчик вызовов, loop detection (позже)

---

## Этап E — Реальные инструменты (fs + shell)
- безопасный tools_fs (list/read/write)
- безопасный tools_shell (allowlist, cwd, timeout)
- UI для результатов

---

## Дальше (по ROADMAP старших этапов)
- Web search (F)
- Retrieval (G)
- Memory (H)
- Cloud venv (K)

---

## 4) Принципы разработки
- “Одна команда — один шаг”
- `.env` не коммитим
- облако — отдельное окружение
- UI: сначала MVP, затем углубление (слои деталей по hover/click)
