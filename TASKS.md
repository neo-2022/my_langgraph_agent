# TASKS — трекер прогресса

Правило:
- `- [ ]` — не сделано
- `- [x]` — сделано
- `- [ ] (IN PROGRESS)` — в работе прямо сейчас

Источник правды по UI/Graph/Run/Debugger: **`CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md`**  
Связанный документ “что и зачем”: `ROADMAP.md`

---

## Уже сделано (база проекта)
- [x] Очистка старых окружений/папок
- [x] Создан проект `~/my_langgraph_agent`
- [x] Создан `venv` (Python 3.12)
- [x] Почищены конфликтующие зависимости (protobuf и лишние пакеты)
- [x] LangGraph проект создан и запускается (`langgraph dev --no-browser`)
- [x] Подключен Ollama через `langchain-ollama` (ChatOllama)
- [x] Добавлены tools: list/set model + probe tool_calls
- [x] Settings UI (локально на 8088) работает
- [x] `run.sh` запускает всё в tmux
- [x] GitHub репозиторий создан и push работает

---

## Этап A — React UI (минимально полезный “мини-Studio”)
- [x] Создать папку `ui/` (Vite + React)
- [x] Настроить запуск UI в dev-режиме (одной командой/из run.sh)
- [x] Сделать базовый layout:
  - [x] левый выдвижной сайдбар (rail + drawers)
  - [x] основная область с вкладками
- [x] Сайдбар: перенести настройки из Settings UI:
  - [x] выбор модели + “Сохранить”
  - [x] кнопка “Перезапустить LangGraph”
  - [x] таблица tool_calls (probe)
- [x] Вкладка “Run”:
  - [x] поле ввода
  - [x] кнопка “Запуск (stream)”
  - [x] вывод ответа
  - [x] отображение tool_calls и результатов tools (в ленте сообщений)
- [x] API-прокси:
  - [x] FastAPI отдаёт `/api/*` и проксирует LangGraph API `127.0.0.1:2024`
  - [x] UI ходит только в `/api/*`
  - [x] Добавлено `/ui/*` через ui_proxy для моделей/настроек

Критерий готовности этапа A:
- [x] из UI можно отправить запрос и видеть шаги model/tools

---

## Этап B — Граф (React Flow) + автолэйаут
- [x] Вкладка “Graph”: отображение nodes/edges из LangGraph
- [x] Zoom/Pan/Drag
- [x] Автолэйаут (Dagre)
- [x] Controls + MiniMap
- [ ] Подсветка активного узла во время выполнения (см. CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md)

---

## Этап B2 — UI Debugger (Split View + Execution Journal)  ← текущий фокус


### B2.0 UI Error Debugger / обработчик ошибок (обязательный слой)
- [ ] Реализовать глобальный слой ошибок UI (см. `CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md`, раздел 1.0):
  - [ ] нормализация в единый формат UiError (scope/severity/title/message/details/ctx/dedupe/actions)
  - [ ] drawer “Ошибки” + глобальный индикатор + dedupe/throttle (без спама)
  - [ ] интеграция: Run / API / Models / Graph / Tools + ErrorBoundary + unhandledrejection/onerror
  - [ ] действия: copy details / перейти к контексту / retry / restart LangGraph / reload
- [ ] Definition of Done: любая ошибка из источников нормализована, видна в панели, не спамит, копируется и ведёт к контексту.

Цель: чтобы во время stream было видно одновременно Run и Graph + появился отдельный журнал выполнения.

### B2.1 Split View (MVP-1)
- [ ] (IN PROGRESS) Режимы: Run only / Graph only / Split
- [ ] Draggable splitter (перетаскивание ширины панелей)
- [ ] min-width: Run >= 360px, Graph >= 420px
- [ ] localStorage: режим + ширина панелей

### B2.2 Подсветка графа из текущих messages/tool_calls (временная, MVP-1)
- [ ] Активный узел: running
- [ ] Завершённый узел: done
- [ ] Ошибка: error
- [ ] Индикатор “долго” (>2s) (пульсация/спиннер)

### B2.3 Execution Journal UI (временная генерация событий, MVP-2)
- [ ] Отдельный блок “Execution Journal” рядом/внутри Run панели
- [ ] События генерируются из messages/tool_calls (временно)
- [ ] Клик по событию → центрировать граф на node/span
- [ ] Клик по ноде → скроллить журнал к связанным событиям + подсветка

---

## Этап B3 — Backend события (настоящие spans)
- [ ] Эндпоинт/стрим событий: node_start/end, tool_start/end, edge_chosen
- [ ] span_id + parent_span_id
- [ ] Гарантия порядка (сервер отдаёт по времени)
- [ ] Интеграция: журнал + подсветка графа питаются реальными событиями

---

## Этап B4 — Breakpoints + управление выполнением
- [ ] Breakpoint toggle на ноде
- [ ] Pause “перед узлом”
- [ ] Кнопки: Continue / Step (MVP=step over) / Stop / Restart (новый run)

---

## Этап C — Runs/Threads (история запусков)
- [ ] Вкладка “History”: список runs/threads
- [ ] Открыть run → показать шаги/сообщения + journal
- [ ] “Повторить запуск” одной кнопкой
- [ ] Поиск/фильтр

---

## Этап D — State: просмотр + diff + таймлайны
- [ ] State snapshots (минимум top-level keys)
- [ ] Diff (added/removed/updated)
- [ ] Таймлайн (длительность узлов/tools, ошибки)
- [ ] Экспорт run’а (json)

---

## Этап E — Реальные инструменты: файлы + shell
- [ ] tools_fs: list/read/write (безопасно)
- [ ] tools_shell: команды (безопасно: cwd/timeout/allowlist)
- [ ] UI: удобный просмотр результатов инструментов

---

## Этап F — Web-поиск
- [ ] Инструмент web-поиска (Tavily или альтернатива)
- [ ] Лимиты/кеш/логирование источников
- [ ] UI: показ источников

---

## Этап G — Retrieval (поиск по документам)
- [ ] Выбор векторной базы (Chroma/FAISS/Qdrant)
- [ ] Индексация документов
- [ ] Retrieval ответы с цитированием
- [ ] UI: загрузка/индексация/поиск

---

## Этап H — Память
- [ ] Хранилище (SQLite/JSON → позже умнее)
- [ ] Правила записи/обновления/удаления
- [ ] UI: просмотр/редактирование памяти

---

## Этап K — Облачные провайдеры (отдельное окружение)
- [ ] Отдельный venv (cloud_venv)
- [ ] OpenAI/Anthropic подключения
- [ ] UI переключатель “локально/облако”
- [ ] Политика: облако только для тяжёлых задач
