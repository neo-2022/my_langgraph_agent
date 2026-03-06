# REGART ↔ Art Integration Contract

Сводка требований для RawEvent/ingest/stream/attachments, чтобы REGART мог быть источником 100% сигналов и Art — доверенной «панелью 0». Документ отражает специфику Art v1 и текущие конвенции REGART.

## 1. RawEvent schema и schema_version
- Все события идут как JSON с обязательным `schema_version` (пример: `"schema_version": "REGART.Art.RawEvent.v1"`). Это поле должно дублироваться и внутри `payload`/`context`, чтобы downstream мог определять формат.
- Основной набор полей (все строки/числа/объекты должны соответствовать ограничениям Art v1): `event_id`, `sequence_id` (если ordering важен), `session_id`, `timestamp`, `kind`, `scope`, `severity`, `title`, `message`, `payload`, `context` (trace_id/span_id/run_id/node_id), `attachments`, `tags`, `attrs`. `payload` допускает дополнительные свойства.
- В schema_version указано, какие конвертеры применять (см. `obs_upgrade`). Приложение поддерживает upgrade/downgrade при наличии `schema_version` и `RawEvent.version_history` (содержит предыдущее значение).
- Контракт подразумевает, что все будущие увеличения полей фиксируются как `schema_version` bumped + описанные в контракте (`REGART.Art.RawEvent.v1`, `REGART.Art.RawEvent.v2` и т. д.).
- Если получено неизвестное поле, оно игнорируется, но логируется как `observability_gap.raw_event_unknown_field`.

## 2. Compatibility / Unknown fields
- UI (zod) строит schema с `.passthrough()` (в `ui/src/obs/rawEvent.schema.js`) и/или `.strip()` для инверсии, чтобы новые поля не ломали старые сборки.
- UI Proxy (pydantic, `agent/src/react_agent/obs_models.py`) использует `Config.extra = "ignore"` или `ConfigDict(extra="ignore")`.
- При downgrade `obs_upgrade` нормализует поля: падение `schema_version` вызывает конвертер к предыдущей версии, удаляя поля, которые отсутствуют в таргете.

## 3. Idempotency и dedup
- `event_id` уникален глобально; генератор в UI должен устойчиво работать от параллельных вкладок (см. тест на 1e5 идентификаторов).
- При возможности добавляется `content_hash` — хеш полезной нагрузки (`sha256(predictable payload)`), чтобы detectar дубли, когда `event_id` совпадает.
- UI Proxy dedup по `event_id` и `source` перед отправкой в Art (уникальный индекс или проверка `SELECT 1 WHERE event_id=?`). Повтор возвращается как «accepted» без повторной доставки.

## 4. Ordering
- Если ordering важен (например, `session_id` определяет run/контекст), используется `sequence_id`, который монотонно растёт внутри сессии. UI outbox сохраняет `sequence_id` и отправляет события строго по возрастанию через один active flush на session_id.
- При потере ordering генерируем `observability_gap.raw_event_order_gap` и пытаемся восстановить по `retry_after_ms`.

## 5. Ingest + Partial ack
- Endpoint `/ui/art/ingest` принимает пакет events и возвращает `partial_ack` JSON следующей формы:

```json
{
  "results": [
    {
      "event_id": "abc123",
      "status": "accepted",
      "reason": null
    },
    {
      "event_id": "def456",
      "status": "retryable",
      "retry_after_ms": 1400,
      "reason": "upstream timeout"
    },
    {
      "event_id": "ghi789",
      "status": "rejected",
      "reason": "malformed payload",
      "canonical_event_id": "ghi_v1"
    }
  ],
  "upto_seq": 102
}
```

- Каждое событие отвечает `status`: `accepted`, `retryable`, `rejected`. `retryable` остаётся в outbox/spool, `accepted` удаляется, `rejected` сохраняется в DLQ.
- При интеграции downstream (`mock Art` или реальный Art ingest) поддерживается `partial_ack` → UI Proxy/Art применяют per-event actions.

## 6. Retry & Timeout policy
- UI: экспоненциальный backoff с параметрами
  - `max_retries = 8`
  - `base_delay_ms = 250`
  - `max_delay_ms = 30_000`
  - `delay = min(max_delay_ms, base_delay_ms * 2^attempt) + jitter[0,250)`
  - После успеха backoff сбрасывается; на `retryable` сохраняется `retry_count` в IndexedDB.
- UI Proxy (httpx) таймауты: `connect_timeout=3s`, `read_timeout=10s`, `write_timeout=10s` (можно объединить `timeout=10s` с `connect=3s`).
- Timeout в UI (fetch wrapper) реализует `AbortController` с `timeout=10s` по умолчанию.
- При превышении таймаута создаётся событие `observability_gap.art_timeout` с контекстом `target=Art` и `timeout_ms`.

## 7. DLQ и observability alerts
- После `max_retries` события переводятся в DLQ (как на UI, так и в UI Proxy sqlite).
- В UI DLQ (`observability_gap.dlq_enqueued`) и `dlq_size` метрика. При появлении первой записи и если DLQ не пуст > 15 мин — `observability_gap.dlq_non_empty`.
- UI Proxy DLQ таблица (sqlite) получает `observability_gap.spool_dlq` и увеличивает Prometheus-метрику `dlq_size`. Алерт на `observability_gap.spool_dlq_non_empty`.
- DLQ для attachments (слишком большой или malware) — `observability_gap.attachment_blocked`.

## 8. Stream (SSE) + cursor/resume
- UI Proxy предоставляет SSE endpoint `/ui/art/stream`, проксирующий Art stream.
- Каждый SSE event содержит `cursor` и `sequence_id`. UI хранит последний принятый курсор и запрашивает resume: `GET /ui/art/stream?cursor=...`.
- Если Art предоставляет ordering (sequence/cursor), UI применяет `sequence` либо сортирует события по `sequence_id`, в противном случае применяется best-effort и генерируется `observability_gap.stream_order_gap`.
- UI SSE слушает `observability_gap.stream_closed` и пытается `retry_after_ms`.

## 9. Attachments безопасность
- Максимальный размер `max_attachment_bytes = 5_242_880` (5 MiB) и обязательно `413 Payload Too Large` с `observability_gap.attachment_too_large`.
- Принимать только mime allowlist: `image/png`, `image/jpeg`, `text/plain`, `application/json`, `application/pdf`.
- Проверка по magic bytes + optional antivirus scan (ClamAV or external scanner). При обнаружении заражения отклонять с `observability_gap.attachment_malware_detected`.
- Все имена файлов очищаются (no `../`, no null bytes) и никогда не рендерятся inline как HTML/JS.
- Attachments хранятся в отдельной директории/таблице, с `metadata.mime`, `metadata.sha256`.

## 10. CORS и логирование
- UI Proxy CORS: allow origins (`http://localhost:5175`, `http://127.0.0.1:5175`), методы `GET, POST, OPTIONS`, headers `Content-Type, Authorization, X-Trace-Id`, preflight caching `max-age=600`.
- Логи фильтруют `Authorization`, `X-API-Key`, `ART_TOKEN`. Любые засекреченные значения заменяются `***` и не появляются в `ui_proxy.log`.
- `observability_gap.log_secret_leak` логируется, если секрет был попыткой залогировать.
- `observability_gap.cors_blocked` при блокировке preflight.

## 11. Observability gap contract
- Все сервисные ошибки (timeout, DLQ, attachments, stream order) покрываются событиями с `kind=observability_gap.*` для Art и UI Debugger.
- Примеры: `observability_gap.spool_corrupted`, `observability_gap.dlq_non_empty`, `observability_gap.art_unreachable`, `observability_gap.attachment_malware_detected`, `observability_gap.raw_event_order_gap`.
- Такие события должны содержать `severity="warn"` или выше и actionable message.

## 12. Summary of guarantees
| Item | Гарантия |
| --- | --- |
| Schema_version | Явное поле, version history, upgrade→downgrade converters |
| Unknown Fields | UI (.passthrough/.strip) и UI Proxy (extra=ignore) не падают |
| Partial Ack | Per-event status + JSON example |
| Retry/Timeout | Числа: retries=8, base=250 ms, max=30 s, jitter | connect=3, read/write=10 |
| DLQ | UI+proxy DLQ, metrics, observability events |
| SSE | `/ui/art/stream`, cursor/resume, ordering gap detection |
| Attachments | allowlist, magic bytes, 413, antivirus, no inline |
| CORS & Logging | allow/preflight, secrets masked |
