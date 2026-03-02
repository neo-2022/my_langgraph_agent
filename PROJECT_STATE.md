# PROJECT_STATE — текущий статус

## 0) TL;DR
- Сейчас делаем: зафиксировали концепцию **сквозного Debugger** (спека) и синхронизируем корневую документацию под неё.
- Блокер: без сквозного Debugger сложно воспроизводить и локализовать баги UI (в т.ч. “пустой граф”) и проблемы Run/Models/Tools/Network.
- Следующий шаг: закоммитить документацию (debugger/README.md + ссылки в README/ROADMAP/TASKS/чеклист), затем начать реализацию **B2.0 UI Error Debugger** по чеклисту (без хардкода).

## 1) Контекст проекта (постоянное)
- Цель проекта: локальный “мини-Studio” для LangGraph-агента: Run (stream), Graph (визуализация), Split, Execution Journal, Debugger и дальнейшая IDE-подобная отладка (breakpoints/step).
- Стек/язык: React (Vite) UI, backend LangGraph локально, UI Proxy как единая точка входа.
- Как запустить локально:
  - `~/my_langgraph_agent/run.sh`
  - Порты: UI http://127.0.0.1:5174, API Docs http://127.0.0.1:2024/docs, UI Proxy http://127.0.0.1:8090
- Основные модули/папки:
  - `agent/` — LangGraph агент (Python)
  - `ui/` — React/Vite UI
  - `debugger/` — модуль сквозного Debugger (спека + будущая реализация)
  - `run.sh` — запуск всего проекта в tmux

## 2) Текущая задача (ONE focus)
**Задача:** Сквозной Debugger (Debugger-1) как инфраструктура диагностики для всего UI: ошибки/события/снапшоты/корреляция.

**Определение готовности (DoD) — Debugger-1 (в рамках B2.0/чеклиста):**
- [ ] Глобальный слой ошибок UI: ErrorBoundary + onunhandledrejection + window.onerror + сетевые/stream ошибки.
- [ ] Нормализация в `UiError` + dedupe/throttle, панель ошибок и глобальный индикатор.
- [ ] Действия: Copy details / Copy debug bundle / Navigate to context / Retry / Restart LangGraph / Reload.
- [ ] UX: кнопка **Debug** (EN) в topbar левее API Docs, хоткей Alt+Ctrl+E, панель ресайзится и сохраняется.
- [ ] Запрет хардкода соблюдён: корреляция/Jump только по данным (`run_id`/`span_id`/`node_id`) или конфигу, без “магических строк”.

**Как воспроизвести ключевой баг, под который нужен Debugger:** “пустой граф”
1) Открыть UI → перейти в Graph (Graph-only) или включить Split.
2) Иногда граф пустой до ручного refresh/смены направления.
Ожидаемое поведение: граф всегда строится автоматически, без ручных “пинков”.

## 3) Что сделано недавно
- Создан модуль `debugger/` и зафиксирована полная спека: `debugger/README.md`.
- Корневая документация синхронизирована ссылками на сквозной Debugger: README/ROADMAP/TASKS/чеклист.

## 4) Известные проблемы / долги
- [ ] Баг: пустой граф в Split и Graph-only до ручного refresh/смены направления.
- [ ] Линтер/качество кода: исправлять только целевыми патчами, не мешать доки и код в одном коммите.
- [ ] CHECKLIST: пункты отмечать [x] только после реальной проверки; перед [x] — всегда спрашивать подтверждение у Артёма.
- [ ] Не оставлять временные решения в репозитории (временное только для локального теста и сразу удалять).

## 5) Ссылки
- README: README.md
- Чеклист UI/Graph/Run/Debugger: CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md
- Спека сквозного Debugger: debugger/README.md
- План/таски: TASKS.md, ROADMAP.md
- Важные файлы (UI):
  - `ui/src/App.jsx` — tabs/topbar/Run/Journal/Graph wiring
  - `ui/src/SplitView.jsx` — режимы run/split и splitter
  - `ui/src/GraphView.jsx` — граф (рендер/fitView/loadGraph)
