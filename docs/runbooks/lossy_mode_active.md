# Lossy mode active

`lossy_mode_active` — это сигнал, что `agent` переключился в режим `drop_oldest_when_full`, когда `UI_PROXY_SPOOL_MAX_EVENTS` исчерпан. Такая ситуация генерирует:

- `observability_gap.spool_full`
- `observability_gap.outbox_full`
- `data_quality.lossy_outbox_drop`
- `spool_dropped_total` и `outbox_dropped_total`

В этом режиме `Spool` удаляет самые старые `pending` события (по `created_at`), чтобы освободить место для новых. Это не означает потерю контроля: каждая операция протоколируется, и downstream может использовать `lossy_mode_active` как триггер для мониторинга качества данных.

**Операционные примеры**

1. Запустить `UI_PROXY_SPOOL_MAX_EVENTS=1` и выставить `UI_PROXY_SPOOL_OVERFLOW_POLICY=drop_oldest_when_full`.
2. Принудительно провалить пересылку в Art (например, `monkeypatch` `_forward_to_art` → `httpx.TimeoutException`).
3. Отправить два события: первое будет помещено в `Spool`, второе приедет, но очередь будет переполнена, старейшее удалится, при этом на выводе появится `data_quality.lossy_outbox_drop`.

**Проверки**

- `pytest -q agent/tests/integration_tests/test_ui_art_ingest.py::test_never_drop_unacked_rejects_new` (режим `never_drop_unacked`).
- Аналогично можно написать тест, который включает `drop_oldest_when_full` и проверяет `data_quality.lossy_outbox_drop` в логах/интерцепторах.
