# CHECKLIST — UI / Graph / Run / Debugger (единый источник правды)

Этот файл фиксирует, **что именно** реализуем.
`TASKS.md` и `ROADMAP.md` должны соответствовать этому списку.

---

## 0) Термины
- **Run** — один запуск агента (input → выполнение → результат).
- **Execution Journal** — отдельный журнал выполнения (не только messages).
- **Span** — единица исполнения: node/tool/model.
- **Active span** — выполняется сейчас.
- **Breakpoint** — пауза перед запуском узла.

---

## 1) Split View (обязательно)

### 1.1 Режимы
- [ ] Run only
- [ ] Graph only
- [ ] Split (Run + Graph)

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
