# CHECKLIST — UI / Graph / Run / Debugger (единый источник правды)
⚠️ ПРАВИЛО: ЗАПРЕЩЕНО что-либо удалять из этого чеклиста без согласования с пользователем.


Этот файл фиксирует, **что именно** реализуем.
`TASKS.md` и `ROADMAP.md` должны соответствовать этому списку.

- [ ] Интеграция **REGART ↔ Art**: выполняется по `CHECKLIST_REGART_ART_INTEGRATION.md` (в этом файле не дублируем требования).

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
- [ ] Единый слой обработки ошибок для UI:
  - [ ] нормализует ошибки из разных источников (Run stream / API / UI proxy / Graph / Tools / React)
  - [ ] отображает их одинаково (панель/тост/индикатор)
  - [ ] даёт действия: copy / details / перейти к контексту / retry / restart
- [ ] Никаких “временных” костылей в репозитории: только финальная реализация (временное — только локально для теста и сразу удалить).

Требования UX/интеграции (обязательные):
- [ ] Debugger работает в фоне с момента старта UI; панель автоматически открывается при error/fatal.
- [ ] Кнопка вызова панели: **Debug** (EN) в верхней панели **левее** ссылки/API Docs.
- [ ] Хоткей: **Alt+Ctrl+E** (toggle панели).
- [ ] Панель ресайзится мышью (drag-resize) и сохраняет размер/состояние (localStorage).
- [ ] Кнопки — EN, tooltips — RU, тексты ошибок/описания — RU.
- [ ] Запрет хардкода: Jump/корреляция только по данным (`node_id`/`span_id`/`run_id`) или конфигу, но не по “магическим строкам”.

- [ ] **Bootstrap Debugger (до React):** Debugger-слой стартует до монтирования UI и способен показать окно отладки, даже если App/React не запустился:
  - [ ] подписка на `window.onerror` и `window.onunhandledrejection` устанавливается **до** `ReactDOM.createRoot(...).render(...)`
  - [ ] при фатальной ошибке старта (App не смонтировался / crash на старте) показывается fallback overlay “Debugger” (без зависимости от React)
  - [ ] overlay позволяет: Copy details (stack/message), закрыть/открыть, и автоматически открывается при error/fatal

#### 1.0.2 Источники ошибок (что обязаны ловить)
- [ ] Run stream:
  - [ ] HTTP ошибки `/api/runs/stream`
  - [ ] SSE парсинг/разрыв потока
  - [ ] AbortError (Stop) — НЕ считать ошибкой, показывать как “Остановлено пользователем”
- [ ] API/Backend:
  - [ ] `/api/openapi.json` (checkApi)
  - [ ] `/api/assistants/search` (loadAssistants)
  - [ ] `/ui/models`, `/ui/model`, `/ui/restart-langgraph`, `/ui/probe-tool-calls`
- [ ] UI Proxy:
  - [ ] health-check / недоступность
- [ ] Graph/ReactFlow:
  - [ ] ошибки загрузки графа/рендера
  - [ ] некорректные данные (пустые/битые nodes/edges)
- [ ] Tools:
  - [ ] ошибки tool_calls / invalid_tool_calls
- [ ] UI runtime (React):
  - [ ] ErrorBoundary для падений компонентов (чтобы UI не белел)
  - [ ] unhandledrejection / window.onerror (минимальная интеграция)

#### 1.0.3 Нормализация ошибки (контракт)
- [ ] Ввести единый формат `UiError`:
  - [ ] `id` (уникальный)
  - [ ] `ts` (timestamp)
  - [ ] `scope` (run|api|graph|models|assistant|tools|ui_proxy|ui)
  - [ ] `severity` (info|warn|error|fatal)
  - [ ] `title` (кратко)
  - [ ] `message` (человеческий текст)
  - [ ] `details` (raw: stack/http/body/json)
  - [ ] `hint` (что делать пользователю)
  - [ ] `ctx` (контекст: run_id, assistant_id, model, node_id, span_id, endpoint)
  - [ ] `dedupe_key` (для анти-спама)
  - [ ] `actions` (copy/retry/open/restart/clear)

#### 1.0.4 UI-поведение (как показываем)
- [ ] Глобальный индикатор ошибок (иконка/бейдж с количеством)
- [ ] Панель “Ошибки” (drawer) со списком:
  - [ ] фильтр по `scope`
  - [ ] группировка по `dedupe_key` + счётчик повторов
  - [ ] сортировка по времени (новые сверху)
- [ ] Встроенные ошибки на местах:
  - [ ] в Run: под инпутом/шагами (как сейчас `runStreamError`, но через общий слой)
  - [ ] в General: ошибки API/checkApi
  - [ ] в Models: ошибки save/probe/restart
- [ ] Не спамить:
  - [ ] одинаковые ошибки схлопывать (dedupe) и увеличивать счётчик
  - [ ] throttle частых ошибок (например 1/сек)
- [ ] Важно: tooltips/подсказки не должны ломаться от error UI (никаких глобальных селекторов).

#### 1.0.5 Действия пользователя (кнопки)
- [ ] Copy:
  - [ ] copy message
  - [ ] copy details (raw json/stack)
  - [ ] copy “debug bundle” (сводка: app version + endpoints + model + run_id + последние N событий)
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
- [ ] Хранить в памяти:
  - [ ] последние N ошибок (например 50–200)
- [ ] Persist (опционально, но полезно):
  - [ ] сохранять в localStorage последние N (чтобы после reload видно было причину)
  - [ ] кнопка “Очистить журнал ошибок”

#### 1.0.7 Интеграция с Execution Journal / Graph
- [ ] Если ошибка связана со span/tool/node:
  - [ ] добавить событие в Execution Journal (status=error)
  - [ ] подсветить ноду error
  - [ ] в инспекторе показывать `short_error` + “копировать”
- [ ] Если ошибка сетевого слоя:
  - [ ] журналировать как системное событие (scope=api/ui_proxy)

#### 1.0.8 Definition of Done (для 1.0)
- [ ] Любая ошибка из списка источников:
  - [ ] нормализована в `UiError`
  - [ ] видна в панели ошибок
  - [ ] имеет минимум: title + message + scope + ts
  - [ ] не спамит (dedupe работает)
  - [ ] можно скопировать детали
  - [ ] по возможности можно перейти к контексту


#### 1.0.9 Сквозной Debugger (полный объём требований) — **самодостаточно “от А до Я”**
> Подробная архитектура/описание: `ui/src/debugger/README.md` (не вместо чеклиста, а как расширенная “книга”).  
> В чеклисте ниже фиксируем **все обязательные** элементы реализации.

**A) Debugger Core (фон, всегда включён)**
- [ ] Debugger Core инициализируется первым при старте UI (до основной логики Run/Graph).
- [ ] Core собирает события/ошибки в ring-buffer (настраиваемые лимиты):
  - [ ] ошибки (например N=200)
  - [ ] breadcrumbs (например N=200)
  - [ ] network события (например N=200)
  - [ ] snapshots (например N=50)
- [ ] Core имеет API:
  - [ ] pushError(UiError)
  - [ ] pushEvent(DebugEvent)
  - [ ] pushSnapshot(source, payload)
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
- [ ] Все запросы UI в сеть (fetch/getJson/postJson) проходят через единый слой логирования:
  - [ ] endpoint, method, status, duration_ms
  - [ ] ошибка/тип/сообщение (если есть)
  - [ ] preview request/response (лимиты; без утечки чувствительных данных)
- [ ] Network события связаны по `trace_id/span_id` с Run/Models/Tools при наличии.

**E) Models Debugger (LLM request/response)**
- [ ] Логировать модельные вызовы (минимум метаданные, оптимально — preview тела):
  - [ ] модель/параметры (temperature/max_tokens/…)
  - [ ] tool_calls/tool_choice (если есть)
  - [ ] response: finish_reason, usage tokens, preview output
  - [ ] ошибки провайдера/парсинга
- [ ] Модельные события коррелируются со span_id (и parent_span_id шага агента/узла).

**F) Tools Debugger (tool_calls)**
- [ ] Для каждого tool call:
  - [ ] tool_name
  - [ ] args/result preview (лимиты)
  - [ ] invalid_tool_calls
  - [ ] ошибки tool execution
- [ ] Корреляция tool spans с parent span (агент/узел) обязательна (когда появятся backend spans).

**G) Graph Debugger (snapshots + диагностика “пустого графа”)**
- [ ] Снапшот графа включает минимум:
  - [ ] assistant_id
  - [ ] nodes/edges count
  - [ ] loading/error
  - [ ] lastFetch/inFlight
  - [ ] размеры контейнера (h/w) и факт наличия инстанса ReactFlow (если применимо)
- [ ] При “пустом графе” после успешной загрузки — сохраняется snapshot с признаком “empty_graph”.
- [ ] Не допускаются “пинки” и workaround’ы как часть финального решения; Debugger нужен для диагностики, а не как костыль.

**H) Debugger Panel UI (единая панель)**
- [ ] Панель существует как overlay/drawer и:
  - [ ] авто-открывается при error/fatal
  - [ ] открывается кнопкой Debug (EN) в topbar левее API Docs
  - [ ] открывается хоткеем Alt+Ctrl+E
  - [ ] ресайзится мышью + сохраняет размер/состояние (localStorage)
- [ ] Секции (включаемые/выключаемые) и фильтры:
  - [ ] Errors
  - [ ] Snapshots (Graph/Run)
  - [ ] Network
  - [ ] Models
  - [ ] Tools
  - [ ] (опционально) Journal-links (поиск по span_id/event_id без дубляжа ленты)
  - [ ] фильтры: scope/level, поиск по тексту/run_id/span_id/node_id
  - [ ] сортировка/группировка (dedupe)
- [ ] Язык UI:
  - [ ] кнопки/табы — EN
  - [ ] tooltips — RU
  - [ ] тексты ошибок/описания/пояснения — RU

**I) Интеграция с Execution Journal (без дубляжа)**
- [ ] Journal остаётся основным списком выполнения; Debugger — источник деталей.
- [ ] Событие Journal имеет ссылку `debug_ref` (event_id/span_id) для подгрузки деталей.
- [ ] В Journal по клику “Details” раскрывается блок, подтянутый из Debugger (ошибка/причины/breadcrumbs/related).
- [ ] “Open in Debugger” открывает панель на конкретной записи и подсвечивает её.
- [ ] Jump работает только по данным node_id/span_id (никаких магических строк).

**J) Debug Bundle (копирование одним блоком)**
- [ ] Copy “debug bundle” содержит:
  - [ ] app/ui версия (если доступна) + timestamp
  - [ ] endpoints status (/api, /ui)
  - [ ] текущая модель (если применимо)
  - [ ] последние N ошибок (с dedupe count)
  - [ ] последние N network событий
  - [ ] последние N snapshots
  - [ ] если выбран span/event → связанные по trace/span цепочке записи


### 1.1 Режимы
- [ ] Run only
- [ ] Graph only
  - [ ] ❗Баг: в режиме Graph-only ноды иногда не появляются при первом открытии (пустой граф).
    Проявляется до тех пор, пока не: обновить страницу / нажать “обновить граф” / сменить направление графа.
  - [ ] Критерий готовности: при входе во вкладку Graph граф всегда автоматически строится (ноды видны) без ручных действий.
- [ ] Split (Run + Graph)
  - [ ] ❗Баг: в Split граф иногда пустой (ноды не рисуются).
    Проявляется до тех пор, пока не: обновить страницу / нажать “обновить граф” / сменить направление графа.
  - [ ] Критерий готовности: при переключении Run ↔ Split, после запуска/стрима, и после ресайза/движения splitter граф стабильно показывает ноды без ручных действий.

### 1.2 Split UX
- [ ] Draggable splitter (перетаскивание ширины панелей)
- [ ] min-width: Run >= 360px, Graph >= 420px
- [ ] Сохранять в localStorage:
  - [ ] режим (run/graph/split)
  - [ ] ширину панелей (split)

### 1.3 Навигация Journal ↔ Graph (MVP)
- [ ] Клик по событию в журнале → центрировать граф на соответствующей ноде/span
- [ ] Клик по ноде → скроллить журнал к связанным событиям + highlight

### 1.4 Зум/панорама графа
- [ ] Колесо мыши для zoom
- [ ] Controls (+/-/fit) доступны в Graph-only и Split

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
