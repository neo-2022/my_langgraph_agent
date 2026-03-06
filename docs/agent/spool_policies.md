# Spool overflow policies

## Политики стойкости очереди

- `never_drop_unacked` — политика по умолчанию. Как только `agent` накопил в `Spool` `UI_PROXY_SPOOL_MAX_EVENTS`, новые события отвергаются с HTTP 507 `spool_full`. Это обеспечивает жёсткий backpressure и питание `observability_gap.spool_full` / `observability_gap.outbox_full`.
- `drop_oldest_when_full` — регулируемая опция. После достижения лимита старейшие `pending` события удаляются, а новые остаются. При этом генерируются `data_quality.lossy_outbox_drop`, `lossy_mode_active` и счётчики `spool_dropped_total` / `outbox_dropped_total`.

## Операционные наблюдаемые события

| Событие | Что означает | Где фиксируется |
| --- | --- | --- |
| `observability_gap.spool_full` | `Spool` достиг максимального числа записей и работает в режиме отказа/обрезки | `agent/src/react_agent/spool.py` |
| `observability_gap.outbox_full` | `UI Proxy` не может записать события в спулы, отправляет HTTP 507 | `agent/src/react_agent/spool.py` и `agent/src/react_agent/ui_proxy.py` |
| `data_quality.lossy_outbox_drop` | Поражён режим `drop_oldest_when_full`, данные удаляются из спула | `agent/src/react_agent/spool.py` |
| `lossy_mode_active` | Подтверждает использование режима `drop_oldest_when_full` | `agent/src/react_agent/spool.py` |
| `spool_dropped_total` / `outbox_dropped_total` | Количество сброшенных событий для контроля потерь | `agent/src/react_agent/spool.py` |

## Проверки

- `pytest -q agent/tests/integration_tests/test_ui_art_ingest.py::test_never_drop_unacked_rejects_new` — проверяет, что при `UI_PROXY_SPOOL_MAX_EVENTS=1` и `never_drop_unacked` второй запрос получает `507 spool_full`.
- Следите за логами: должны появляться `observability_gap.spool_full`, `observability_gap.outbox_full`, `data_quality.lossy_outbox_drop` и `lossy_mode_active`.

## Как переключиться

Установите переменные окружения:

```bash
export UI_PROXY_SPOOL_MAX_EVENTS=500
export UI_PROXY_SPOOL_OVERFLOW_POLICY=drop_oldest_when_full
```

В режиме `drop_oldest_when_full` система продолжит принимать события, но ожидается появление `observability_gap`-событий с lossy метриками.
