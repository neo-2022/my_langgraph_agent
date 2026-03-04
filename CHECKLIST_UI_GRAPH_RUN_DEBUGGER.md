# CHECKLIST — UI / Graph / Run / Debugger (единый источник правды)
⚠️ ПРАВИЛО: ЗАПРЕЩЕНО что-либо удалять из этого чеклиста без согласования с пользователем.


Этот файл фиксирует, **что именно** реализуем.
`TASKS.md` и `ROADMAP.md` должны соответствовать этому списку.

- [x] Интеграция **REGART ↔ Art**: выполняется по `CHECKLIST_REGART_ART_INTEGRATION.md` (в этом файле не дублируем требования).

---

## 0) Термины
- **Run** — один запуск агента (input → выполнение → результат).
- **Execution Journal** — отдельный журнал выполнения (не только messages).
- **Span** — единица исполнения: node/tool/model.
- **Active span** — выполняется сейчас.
- **Breakpoint** — пауза перед запуском узла.

---

## 1) Split View (обязательно)

### 1.0 UI Error Debugger / обработчик ошибок (новое добавление, обязательный слой)

#### 1.0.1 Цель и принцип
 - [x] Единый слой обработки ошибок для UI (ui/src/debugger/core.js, ui/src/debugger/README.md):
   - [x] нормализует ошибки из разных источников (Run stream / API / UI proxy / Graph / Tools / React)
   - [x] отображает их одинаково (панель/тост/индикатор)
   - [x] даёт действия: copy / details / перейти к контексту / retry / restart
 - [x] Финальная реализация без временных костылей (весь функционал в `ui/src/debugger/*`).

Требования UX/интеграции (обязательные):
 - [x] Debugger всегда работает в фоне: кнопка `Debug`, хоткей Alt+Ctrl+E, drag-resize + localStorage, RU-тексты (ui/src/App.jsx + ui/src/debugger/panel).
 - [x] Корреляция идёт по полям (`node_id/span_id/run_id`) из `UiError.ctx`, без “магии”.

- [ ] **Bootstrap Debugger (до React):** Debugger-слой стартует до монтирования UI и способен показать окно отладки, даже если App/React не запустился:
- [x] `initDebuggerLevel0()` (ui/src/main.jsx + level0) встаёт до `createRoot`, подписывает global handlers и отображает fallback overlay с copy/details (ui/src/debugger/atlas).

#### 1.0.2 Источники ошибок (что обязаны ловить)
- [x] Run stream errors (http/network) и AbortError обработаны через `ui/src/obs/runStream`, `ui/src/debugger/network.js`.
- [x] API/backend endpoints (`checkApi`, assistants search, `/ui/models`, `/ui/restart-langgraph`, `/ui/probe-tool-calls`) логируются и показываются как `UiError` (`ui/src/obs/httpClient.js`, `ui/src/debugger/network.js`).
- [x] UI Proxy health/недоступность фиксируются через `ui/src/debugger/proxy.js` и `agent/src/react_agent/ui_proxy.py`.
- [x] Graph/ReactFlow ошибки и битые nodes/edges обрабатываются в `GraphView.jsx` и `ui/src/debugger/errorsGraph.js`.
- [x] Tools errors (`tool_calls`, `invalid_tool_calls`) отслеживаются в `ui/src/debugger/tools.js`.
- [x] React runtime/ErrorBoundary, `window.onerror`/`unhandledrejection` включены через Level0 (`ui/src/ErrorBoundary.jsx`, `ui/src/debugger/level0.js`).

#### 1.0.3 Нормализация ошибки (контракт)
- [x] `UiError` определён в `ui/src/debugger/core.js`/`README`: поля `id`, `ts`, `scope`, `severity`, `title`, `message`, `details`, `hint`, `ctx`, `dedupe_key`, `actions` заполнены таблицей (см. `ui/src/debugger/README.md`).

#### 1.0.4 UI-поведение (как показываем)
- [x] Глобальный индикатор ошибок (иконка/бейдж + drawer с фильтрами/количеством).
- [x] Drawer реализует фильтр по `scope`, группировку по `dedupe_key`, сортировку по времени (`ui/src/debugger/panel`).
- [x] Встроенные ошибки: Run/General/Models используют тот же слой (`ui/src/debugger/errorsRun.js`, `ui/src/debugger/errorsModels.js`).
- [x] Dedup/throttle + неизменные тултипы направлены на стабильность (core.js).

- #### 1.0.5 Действия пользователя (кнопки)
- [x] Copy message/details/debug bundle (`ui/src/debugger/errorActions.jsx`).
- [ ] Navigate to context:
  - [ ] если есть `run_id` → открыть Run и подсветить
  - [ ] если есть `node_id/span_id` → центрировать Graph на ноде/span
  - [ ] если есть `endpoint` → показать, где упало (например models/api)
- [ ] Retry (если применимо):
  - [ ] retry checkApi
  - [ ] retry loadAssistants
  - [ ] retry loadModels / probe
  - [ ] retry runStream (опционально)
- [ ] Restart:
  - [ ] “Перезапустить LangGraph сервер”
  - [ ] “Обновить страницу” (инструкция/кнопка location.reload)

#### 1.0.6 Логи/буфер ошибок
- [x] Core хранит последние N ошибок/breadcrumbs/network/snapshots и сохраняет в памяти (ui/src/debugger/core.js).
- [x] LocalStorage persistence + кнопка “Очистить журнал” реализованы (ui/src/debugger/panel/DebugPanel.jsx).

#### 1.0.7 Интеграция с Execution Journal / Graph
- [x] Ошибки span/tool/node добавляются в Execution Journal и подсвечивают ноду (`ui/src/debugger/graph.js`, `GraphView.jsx`).
- [x] Инспектор показывает `short_error` + копирование (`ui/src/debugger/panel/Inspector.jsx`).
- [x] Сетевые ошибки логируются как системные события (scope=api/ui_proxy) через `ui/src/debugger/network.js`.

#### 1.0.8 Definition of Done (для 1.0)
- [x] Любая ошибка: нормализована в `UiError`, появляется в панели, содержит title/message/scope/ts, не спамит (dedupe) и поддерживает copy/jump (см. ui/src/debugger/*.js).  


#### 1.0.9 Сквозной Debugger (полный объём требований) — **самодостаточно “от А до Я”**
> Подробная архитектура/описание: `ui/src/debugger/README.md` (не вместо чеклиста, а как расширенная “книга”).  
> В чеклисте ниже фиксируем **все обязательные** элементы реализации.

**A) Debugger Core (фон, всегда включён)**
- [x] Core стартует первым и собирает события/ошибки в ring-buffer (errors/breadcrumbs/network/snapshots). Все методы (`pushError/pushEvent/pushSnapshot`) реализованы в `ui/src/debugger/core.js`.
  - [ ] subscribe(listener) для UI панели
- [ ] Core делает dedupe + throttle (без спама), как описано в 1.0.4.

**B) Единый формат событий (DebugEvent) и корреляция (без хардкода)**
- [ ] Ввести формат `DebugEvent` (дополнение к UiError, для событий/трейса):
  - [ ] `event_id`, `ts`, `level`, `name`, `origin`
  - [ ] корреляция: `trace_id`, `span_id`, `parent_span_id?`, `run_id?`, `assistant_id?`, `node_id?`
  - [ ] `attrs`, `payload` (preview/full-ref)
  - [ ] `links` (related_span_ids / related_event_ids)
- [ ] Корреляция и “Jump to context” строятся **только по данным** (`run_id`/`span_id`/`node_id`/`trace_id`/`links`) — никаких маппингов строками.
- [ ] Поддержать `error.cause` / AggregateError (если встречается) в “цепочке причин” (без угадываний).

**C) UI Error Debugger (ошибки UI/runtime)**
- [ ] Источники (дополнительно к 1.0.2):
  - [ ] window.onerror
  - [ ] window.onunhandledrejection
  - [ ] React ErrorBoundary (ошибки рендера/эффектов компонентов)
- [ ] Каждая ошибка:
  - [ ] нормализуется в `UiError`
  - [ ] получает `ctx` (tab/endpoint/run_id/assistant_id/span_id/node_id при наличии)
  - [ ] имеет “человеческое RU-описание” + hint + действия
- [ ] Ошибка содержит ссылку на место:
  - [ ] file/line/col (если можно извлечь)
  - [ ] (dev) действие “Open in editor” (если есть рабочий механизм)

**D) Network Debugger (UI → /api/* и /ui/*)**
- [x] Все HTTP-вызовы проходят через `ui/src/obs/httpClient.js`; логируются endpoint, method, status, duration, previews без секретов (`ui/src/debugger/network.js`).
- [x] Network события связываются по `trace_id/span_id` с Run/Models/Tools (core + correlator).

**E) Models Debugger (LLM request/response)**
- [x] Модельные вызовы логируются (model params, tool_calls, finish_reason/usage) через `ui/src/debugger/models.js` и `graph` events.
- [x] События кореллируются со span_id и parent span (Execution Journal + Graph). 

**F) Tools Debugger (tool_calls)**
- [x] Каждый tool_call логируется (name, args preview, invalid_tool_calls, ошибки) через `ui/src/debugger/tools.js`.
- [x] Корреляция tool spans с parent span реализована (Graph + Execution Journal связываются). 

**G) Graph Debugger (snapshots + диагностика “пустого графа”)**
- [x] Snapshots содержат assistant_id, nodes/edges count, loading/error, lastFetch/inFlight, размеры контейнера и факт ReactFlow (GraphView thr). 
- [x] При пустом графе сохраняется snap с “empty_graph”, дополнительные Workaround запрещены (ui/src/debugger/graph.js + GraphView logic).

**H) Debugger Panel UI (единая панель)**
- [x] Debug drawer авто-открывается при error/fatal, кнопка Debug + Alt+Ctrl+E, resize + localStorage (`ui/src/App.jsx`, `ui/src/debugger/panel`).
- [x] Секции Errors/Snapshots/Network/Models/Tools и фильтры scope/level/search реализованы (ui/src/debugger/panel sections).
- [x] UI язык: кнопки EN, tooltips/описания RU (UI strings in `ui/src/debugger/README.md`).

**I) Интеграция с Execution Journal (без дубляжа)**
- [x] Journal остаётся главным списком, Debugger предоставляет детали и `debug_ref` (ui/src/journal, ui/src/debugger/journal). 
- [x] “Details” поднимает Debugger (ui/src/journal/JournalEntry.jsx) и jump работает только по node_id/span_id.

**J) Debug Bundle (копирование одним блоком)**
- [x] Debug bundle копирует версию, endpoints, модель, последние ошибки/network/snapshots и trace-linked записи (`ui/src/debugger/errorActions.jsx`).


### 1.1 Режимы
- [x] Run only — режим работает (`App.jsx` переключает tab='run', SplitView управляет `splitMode`).
- [x] Graph only — `App.jsx` монтирует `<GraphView>` и `GraphView.jsx` вызывает `loadGraph()` в `useEffect` при mount/assistantId/direction, так что граф загружается/отрисовывается автоматически (багов “пустой граф” нет).
- [x] Split (Run + Graph) — `<SplitView>` содержит Graph в правой панели, `loadGraph` вызывается из того же компонента, `splitMode`/splitter сохраняются в localStorage; после переключения Run↔Split/ресайза/запуска Graph подхватывает ноды без ручного обновления.

- ### 1.2 Split UX
- [x] Draggable splitter реализован (`ui/src/SplitView.jsx` drag handlers).
- [x] Вспомогательные min-width (Run 360px, Graph 420px) добавлены в SplitView на панели и single mode.
- [x] Split mode + tab режим сохраняются в `localStorage` (`splitview:mode`, `splitview:tab`, `splitview:left_pct`).

### 1.3 Навигация Journal ↔ Graph (MVP)
- [ ] Клик по событию в журнале → центрировать граф на соответствующей ноде/span
- [ ] Клик по ноде → скроллить журнал к связанным событиям + highlight

### 1.4 Зум/панорама графа
- [x] Колесо мыши для zoom (ReactFlow ScrollZoom, `ui/src/GraphView.jsx`).
- [x] Controls (+/-/fit) доступны в Graph-only и Split (`<Controls />` внутри `GraphView`, используется и в SplitView, и в tab="graph`).

---

## 2) Execution Journal (критично)

### 2.1 Отдельно от messages
- [ ] UI показывает:
  - [ ] messages (как сейчас)
  - [ ] отдельный “Execution Journal” (список событий / timeline)

### 2.2 Минимальная JSON-схема события (контракт)
События приходят **уже в порядке времени** (UI не сортирует).

#### 2.2.1 Расширение контракта (оптимально, без хардкода)
- [ ] Контракт расширяем до сквозного DebugEvent/trace (см. `ui/src/debugger/README.md`):
  - [ ] `trace_id` (единая цепочка)
  - [ ] `span_id` и `parent_span_id` (причинность)
  - [ ] `node_id` (Jump на граф) — только если сервер может дать точную привязку
  - [ ] `links`/`related_span_ids` (связанные операции)
- [ ] UI не угадывает `node_id`: Jump возможен только если `node_id`/`span_id` есть в событии.
- [ ] Событие может содержать `debug_ref` (event_id/span_id) для подгрузки Details из Debugger Core (без дубляжа данных).

- [ ] type: node_start | node_end | tool_start | tool_end | edge_chosen
- [ ] timestamp: ISO 8601
- [ ] run_id: uuid
- [ ] span_id: string (уникальный id span)
- [ ] parent_span_id?: string
- [ ] status: running | ok | error
- [ ] duration_ms?: number

Идентификация:
- [ ] node_id?: string (для node_*)
- [ ] tool_name?: string (для tool_*)

Edge (только для edge_chosen):
- [ ] edge.source, edge.target
- [ ] edge.label? (маршрут A / поиск / fallback)
- [ ] edge.reason? (почему выбран)

Дополнительно:
- [ ] metadata: object (произвольные данные)

---

## 3) Подсветка на графе во время stream (обязательно)

### 3.1 Базовый слой (всегда видно)
- [ ] Активный узел: running
- [ ] Завершённый узел: done
- [ ] Ошибка: error

### 3.2 Долгие операции
- [ ] Если узел running > 2s → показать индикатор (пульсация/спиннер)

### 3.3 Conditional edges
- [ ] Подсветка выбранной ветки
- [ ] Debug Mode: все возможные conditional edges серым, активную подсвечивать + label

### 3.4 Parent tracking (важно для параллельности)
- [ ] parent_span_id обязателен в событиях
- [ ] UI показывает, кто вызвал узел (подсветка входящего ребра / бейдж called by)

---

## 4) Инспектор узла (клик) + детали (обязательно)

### 4.1 Hover
- [ ] статус + duration
- [ ] для tools-node: текущий tool_name (если есть)

### 4.2 Click (Inspector)
- [ ] список связанных событий (node_start/end, tool_* внутри)
- [ ] tool_name + short_result/short_error (для tools)
- [ ] timestamps start/end + duration
- [ ] “Copy to clipboard” для:
  - [ ] результата
  - [ ] ошибки
  - [ ] diff/json

---

## 5) State diff (MVP упрощённый, но пункт обязателен)

- [ ] Хранить state_before/state_after (минимум: top-level keys)
- [ ] Формат diff (MVP):
  - [ ] added: {k:v}
  - [ ] removed: [k]
  - [ ] updated: {k:newV}
- [ ] Глубина: только верхний уровень (без рекурсивного diff)

---

## 6) Метрики и диагностика

- [ ] duration на node/tool spans
- [ ] slow-node (MVP): duration_ms > 2000 → оранжевый индикатор
- [ ] счётчик вызовов узла:
  - [ ] показывать badge ×N только если N > 1
- [ ] (позже) динамические baseline/avg/p95 и loop-detect

---

## 7) Breakpoints + управление выполнением (обязательно)

### 7.1 UI
- [ ] Toggle breakpoint на ноде
- [ ] На breakpoint run паузится “перед узлом”
- [ ] Кнопки управления:
  - [ ] Continue
  - [ ] Step (MVP = step over)
  - [ ] Stop
  - [ ] Restart (новый run с нуля)

### 7.2 Future
- [ ] Step into (когда есть под-спаны внутри узла)

---

## 8) Приоритеты реализации (фикс)

### MVP-1
- [ ] Split View + сохранение
- [ ] Базовая подсветка графа (временная, из messages/tool_calls)

### MVP-2
- [ ] Execution Journal UI (временная генерация событий из messages/tool_calls)
- [ ] Навигация Journal ↔ Graph (клик → центрирование/скролл)

### Backend-1
- [ ] Реальные события node/tool + edge_chosen + parent_span_id + span_id
- [ ] Подключить события к журналу и подсветке

### Debugger-1
- [ ] Реальные breakpoints + Continue/Step/Stop/Restart

### Далее
- [ ] state diff расширенный
- [ ] loop detection + экспорт
- [ ] динамические метрики

---

## 9) UX тест и подсказки
- [ ] Прогон длинных сессий (проверка лагов/частоты обновлений)
- [ ] Мини-справка в UI: hover/click/zoom/fit + Debug Mode
