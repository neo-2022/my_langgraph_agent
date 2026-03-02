# DEBUGGER_SPEC — Сквозной Debugger для my_langgraph_agent (v1)

Дата: 2026-03-02  
Статус: спецификация/описание (источник требований для реализации)  
Язык: документация — русский; UI-кнопки — английский; tooltip — русский; текст ошибок/описания — русский.

---

## 0) Цель (что строим)

Мы строим **сквозной Debugger**, который:

1) Работает **в фоне с момента старта UI** (инициализируется раньше остальных частей UI).
2) Пропускает через себя ключевые потоки проекта:
   - ошибки UI/runtime,
   - сетевые запросы UI→API/UI Proxy,
   - события выполнения (Execution Journal / spans),
   - модельные вызовы (request/response/usage/errors),
   - tool calls (args/results/errors),
   - граф (snapshots, состояние отрисовки, загрузка, пустой граф).
3) Имеет **единый интерфейс Debugger Panel**, который:
   - автоматически **появляется при ошибках**,
   - вызывается вручную кнопкой в topbar и хоткеем,
   - масштабируется: разделы можно включать/выключать, есть фильтры/сортировки,
   - позволяет “Jump to context” (Run/Graph/Models/Tools/Network) без догадок и без хардкода.
4) Создаёт **понятное человеческое объяснение ошибок на русском** + даёт ссылку на место (файл/строка/колонка) + показывает “цепочку причин/зависимостей”.

---

## 0.1) Bootstrap Layer (Level 0) — Debugger до React (обязательное требование)

Это слой, который запускается **до** монтирования React UI (до `ReactDOM.createRoot(...).render(...)`), чтобы выполнить требование:

- Debugger запускается первым в фоне.
- Если остальной UI/проект **не запускается** (ошибка загрузки/инициализации/падение на старте), **всё равно появляется окно отладки**.

**Обязательное поведение Level 0:**
- Ставит хендлеры `window.onerror` и `window.onunhandledrejection` до старта React.

**Точка интеграции в этом репозитории (явно):**
- `ui/src/main.jsx` — инициализация Level 0 выполняется **до** строки `createRoot(...).render(...)`.
- В `ui/index.html` подключается `src/main.jsx`, поэтому всё, что стоит в `main.jsx` до `render`, гарантированно запускается первым.

**Обязательное поведение Level 0 (продолжение):**
- Имеет fallback overlay (простая HTML/CSS/JS панель), которая:
  - автоматически открывается при error/fatal,
  - позволяет Copy details (сообщение, stacktrace, время, userAgent),
  - позволяет закрыть/открыть панель (toggle),
  - не зависит от React (работает, даже если React не смонтировался).

**DoD Level 0 (проверка готовности):**
- Искусственно сломать старт UI (например, выбросить ошибку до `render`) → overlay появляется и содержит данные ошибки.
- Никаких “тихих” падений: ошибка должна быть видна и копируема.


## 1) Неформальные требования (UX/поведение)

### 1.1 Вызов и автопоказ
- Debugger работает всегда (фон), UI-панель открывается:
  - автоматически при первой ошибке уровня error/fatal;
  - вручную:
    - кнопка **Debug** (EN) в верхней панели **левее** кнопки/ссылки API Docs,
    - горячая клавиша: **Alt+Ctrl+E** (toggle панели).

### 1.2 Размер/перетаскивание
- Панель Debugger — это overlay/drawer, который:
  - можно **растягивать мышью** (resize) по ширине/высоте (как минимум — по ширине),
  - сохраняет размер/состояние открытия (localStorage).

### 1.3 Язык
- Кнопки/краткие названия вкладок: **на английском**.
- Tooltip при наведении: **на русском** (коротко и понятно).
- Текст ошибок, пояснения, детали, подсказки “что делать”: **на русском**.

### 1.4 Стиль
- Визуально соответствует основному стилю проекта (цвета/шрифты/кнопки).
- Не ломает существующие tooltip/оверлеи.

### 1.5 Без хардкода (жёсткое правило)
- Любые маппинги/правила “если X → значит Y” **не допускаются** в коде UI/Debugger.
- Любая корреляция “событие → нода графа” должна идти **из данных** (node_id/span_id) или из конфигурируемых правил (предпочтительно — от backend).
- Не допускаются “магические строки” типа `"tools"`, `"call_model"` как логика привязки.

---

## 2) Роль Debugger относительно Journal

### 2.1 Journal — основной интерфейс выполнения
- Execution Journal остаётся основным местом, где пользователь кликает событие:
  - клик → **Jump** (центрирование графа на node/span, если есть ссылка),
  - раскрытие события → **Details**.

### 2.2 Debugger — источник деталей и системной диагностики
- Debugger НЕ дублирует Journal как “ещё один журнал”.
- Debugger хранит:
  - нормализованные ошибки,
  - цепочки причин (cause/parent/links),
  - breadcrumbs (последние события окружения),
  - snapshots (graph/run/network),
  - network traces.
- Journal при раскрытии **подтягивает детали из Debugger** по ссылке `debug_ref` (event_id/span_id).
- Из Journal доступно действие **Open in Debugger** → открывает панель на нужной записи.

---

## 3) Архитектура: ядро + провайдеры

Debugger состоит из:

1) **Debugger Core** (фон):
   - хранит события (ring buffers),
   - нормализует ошибки,
   - делает dedupe/throttle,
   - даёт API подписки (subscribe),
   - обеспечивает поиск/фильтрацию/выбор.

2) **Providers** (источники событий):
   - UI runtime errors provider,
   - Network provider (fetch wrapper),
   - Run stream provider (SSE/stream),
   - Models provider,
   - Tools provider,
   - Graph provider (snapshots, граф “пустой”, размеры контейнера),
   - Backend spans provider (когда появится B3).

3) **Debugger Panel UI**:
   - отображает каналы (Errors/Snapshots/Network/Graph/Models/Tools),
   - фильтры/поиск/сортировки,
   - действия Copy/Clear/Open/Retry/Restart/Reload/Jump.

---

## 4) Единый формат событий (DebugEvent v1)

### 4.1 Конверт события (универсальный)
Каждое событие — объект:

- `schema_version`: "debug_event@1"
- `event_id`: string (uuid)
- `ts`: ISO 8601
- `level`: debug|info|warn|error|fatal
- `name`: namespaced string (например: ui.exception, network.http, model.request, tool.end, graph.snapshot, journal.node_start)
- `origin`: frontend|backend

Корреляция (для “цепочки причин” и навигации):
- `trace_id`: string (одна цепочка)
- `span_id`: string (операция)
- `parent_span_id?`: string
- `run_id?`: uuid
- `assistant_id?`: string
- `node_id?`: string (только если есть реальная привязка к графу)

Контекст UI:
- `ui.tab?`: run|graph|split|journal|models|tools|…
- `ui.route?`: string
- `ui.session_id?`: string

Данные:
- `attrs`: object (произвольные атрибуты)
- `payload`: object (детали; большие данные — по ссылке)

Ссылки:
- `links?`: { related_event_ids?: string[], related_span_ids?: string[] }

---

## 5) Нормализация ошибок (UiError)

В UI используется единый формат ошибки **UiError** (из CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md / 1.0.3), расширенный для твоих требований:

Обязательные поля:
- `id`, `ts`
- `scope`: run|api|graph|models|assistant|tools|ui_proxy|ui|network
- `severity`: info|warn|error|fatal
- `title`: коротко (RU)
- `message`: понятный текст (RU)
- `details`: raw stack/http/body/json (как данные)
- `hint`: что сделать пользователю (RU)
- `ctx`: run_id, assistant_id, model, node_id, span_id, endpoint, tab
- `dedupe_key`: анти-спам ключ
- `actions`: список возможных действий (copy/retry/open/restart/reload/jump)

### 5.1 Требование “ссылка на место в файле”
UiError должен иметь:
- `location`: { file, line, col, function? }
- `open_in_editor?`: { url } (dev-режим)
Источник location:
- stacktrace + sourcemaps (в dev),
- backend-ошибки: file/line если сервер отдаёт, либо endpoint + request id.

### 5.2 Требование “зависимости, которые вызвали ошибку”
UiError должен иметь:
- `causes[]`: список причин (из error.cause, AggregateError, parent_span_id chain)
- `breadcrumbs[]`: последние N событий окружения (network/journal/ui actions)
- `related[]`: связанные spans/events (links)

Важно: причинность строится только по данным (`parent_span_id`, `trace_id`, `links`), не по “угадайкам”.

---

## 6) Dedupe/Throttle (анти-спам)

### 6.1 Dedupe
- Ошибки с одинаковым `dedupe_key` группируются:
  - показываем одну запись + счётчик повторов + последнее время.
- `dedupe_key` строится из:
  - scope + error type + message template + endpoint + top frame (если есть).

### 6.2 Throttle
- Частые одинаковые ошибки — не чаще 1/сек (параметр настраиваемый).
- Не троттлить fatal.

---

## 7) Каналы и что именно дебажим

### 7.1 UI runtime (React/Browser)
Собираем:
- window.onerror
- window.onunhandledrejection
- ErrorBoundary (ошибки рендера компонентов)
Действия:
- Copy, Open in Debugger, Reload
- Jump to context (если ctx содержит run_id/node_id/span_id)

### 7.2 Network (UI → /api/* и /ui/*)
Собираем:
- метод, url, статус, duration_ms
- ошибка (если есть), retryable
- preview тела/ответа (с лимитами)
Действия:
- Copy request/response meta
- Retry (если применимо)
- Open endpoint context (например Models/API)

### 7.3 Models (LLM)
Собираем:
- model.request: параметры, preview prompts/messages/tools schema
- model.response: finish_reason, usage tokens, preview output/tool_calls
- ошибки провайдера/парсинга
Действия:
- Copy bundle по span_id
- Jump to related node (если backend дал node_id)

### 7.4 Tools
Собираем:
- tool.start / tool.end
- args preview / result preview
- invalid_tool_calls / ошибки
Действия:
- Copy args/result/error
- Jump (node_id если есть)

### 7.5 Execution Journal / spans (B3)
Собираем события:
- node_start/node_end/tool_start/tool_end/edge_chosen
Контракт (оптимальный):
- гарантированный порядок событий (сервер)
- span_id + parent_span_id
- node_id/tool_name по необходимости
Действия:
- Jump (node_id)
- Open details (по debug_ref/span_id)

### 7.6 Graph
Собираем snapshots:
- загрузка графа, nodes/edges count
- размеры контейнера, наличие ReactFlow instance
- признак “graph пустой”
Действия:
- Copy snapshot
- Open in Debugger → Graph tab

---

## 8) Навигация и Jump без хардкода

### 8.1 Правило Jump
- Jump выполняется **только если** у события/ошибки есть:
  - `node_id` (предпочтительно) или
  - `span_id` + возможность найти соответствующий node_id через данные/индексы (без хардкода).
- UI не делает маппинг “tool_calls → tools”.
- Временные эвристики запрещены.

### 8.2 Реализация Jump
- В App хранится “фокус” (focusNodeId) как UI-состояние.
- Но focusNodeId заполняется только из `node_id` события (backend данных).

---

## 9) Хранение и лимиты (производительность)

- ring buffer по каждому каналу (например 50–200 записей, настраиваемо)
- большие payload хранятся как:
  - `preview` (короткий текст) + `hash`
  - `full_ref` (если включено пользователем)
- защита от утечек:
  - опциональная “редакция” (mask) для чувствительных данных

---

## 10) Debugger Panel UI (структура)

Вкладки/разделы (включаемые):
- Errors
- Journal (только ссылки/поиск по span_id; не дубль списка)
- Snapshots (Graph/Run)
- Network
- Models
- Tools

Функции:
- поиск (по тексту, event_id, span_id, run_id)
- фильтр scope/level
- сортировка (время/severity)
- группировка (dedupe)
- действия:
  - Copy (выбор: summary/details/bundle)
  - Clear
  - Open in Debugger (deep-link)
  - Retry (по контексту)
  - Restart LangGraph
  - Reload
  - Jump (если node_id/span_id)

---

## 11) “Debug Bundle” (копирование одним блоком)

Copy Bundle должен включать:
- версия UI (commit hash если доступен), время, url
- текущие endpoints status (api/ui_proxy)
- активные настройки модели (если есть)
- последние N ошибок (с dedupe)
- последние N network событий
- последние snapshots (graph/run)
- если пользователь выделил event/span → связанные события по trace/span цепочке

---

## 12) Связь с документацией проекта

Источник правды по UI/Graph/Run/Debugger:
- CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md

TASKS.md и ROADMAP.md должны соответствовать чеклисту.

Этот файл — подробная спека для реализации сквозного Debugger и дальнейшего расширения.

---

## 13) Definition of Done (уровень Debugger-1)

Debugger-1 считается готовым, когда:
- ловятся ошибки из источников 1.0.2 чеклиста,
- каждая ошибка нормализована в UiError,
- есть панель Errors (drawer/overlay) + индикатор,
- dedupe/throttle работают (не спамит),
- есть Copy details и Copy bundle,
- есть Jump to context при наличии node_id/span_id/run_id,
- кнопка Debug стоит в topbar левее API Docs,
- хоткей Alt+Ctrl+E работает,
- UI-panel ресайзится мышью и сохраняет размер/открытие.

