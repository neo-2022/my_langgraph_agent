# Operational notes — REGART ↔ Art

## Ключевые переменные окружения
| Переменная | Что влияет | Пример | Описание |
|---|---|---|---|
| `LANGGRAPH_SYSTEMD_SERVICE` | UI Proxy → кнопка «Перезапустить LangGraph сервер» | `my_langgraph.service` | Имя systemd-сервиса LangGraph, в который будут отправляться `systemctl --user restart` / `start` / `stop`. Устанавливается в `~/.bashrc`/`~/.profile`/`.env` до запуска UI Proxy. |
| `LANGGRAPH_DEFAULT_SYSTEMD_SERVICE` | fallback | `my_langgraph.service` | Стандартное имя, используется если `LANGGRAPH_SYSTEMD_SERVICE` не задан. |
| `ART_INGEST_URL` | UI Proxy → Art ingest | `http://127.0.0.1:7331/api/v1/ingest` | URL, куда UI Proxy форвардит события. |
| `ART_STREAM_URL` | UI Proxy → Art stream | `http://127.0.0.1:7331/api/v1/stream` | SSE-канал, к которому проксируется UI stream. |
| `REGART_INGEST_TOKEN` | UI Proxy ingest auth | `super-secret-token` | Токен Bearer для эндпоинтов `/ui/ingest/events` и `/ui/art/ingest`. Без него 401/403. |
| `UI_PROXY_SPOOL_PATH` | sqlite spool (UI Proxy offline) | `~/.local/share/regart/ui_proxy_spool.db` | Путь к sqlite-файлу, используется при заполнении очереди (`spool_events`). |
| `UI_PROXY_SPOOL_RETENTION` | retention | `86400` | В секундах; по умолчанию 24 ч, очищает старые записи `spool_events` и `spool_dlq`. |
| `ATTACHMENT_MAX_BYTES` | макс. размер вложения | `5242880` | 5 МБ по умолчанию; используется при `POST /ui/attachments`. |
| `ATTACHMENT_SCANNER_CMD` | дефолтный сканер вложений | (напр. `clamscan`) | Команда запускает сканер; при `returncode=0` вложение безопасно, при `1` — блокируется с сообщением. |
| `UI_PROXY_PORT`, `REACT_PORT` | локальные сервисы | `8090`, `5174` | Порты UI Proxy и React UI; `run.sh` выставляет их автоматически.

## Метрики и события
- `observability_gap.dlq_size` — размер очереди DLQ в UI или UI Proxy; сопровождается `payload.size`.
- `observability_gap.dlq_enqueued` — одно событие добавлено в DLQ; полезно для алертов >0.
- `observability_gap.dlq_non_empty` — впервые после появления DLQ размер >0 или спустя >15 минут; служит сигналом, что нужно разбирать очередь.
- `observability_gap.outbox_flush_failed` — UI не может сбросить outbox в Art/Proxy (например, таймаут или 502). Мониторим `pending` и `error` в `payload`.
- `observability_gap.spool_corrupted` — sqlite spool оказался повреждён; UI Proxy переключается на in-memory очередь и пишет этот gap.
- HTTP таймауты в UI Proxy: `ART_CONNECT_TIMEOUT=3s`, `ART_READ_TIMEOUT=10s`, `ART_WRITE_TIMEOUT=10s` (также применяются к `ART_STREAM_URL`).
- Скрипты `scripts/load_test.py` + `scripts/mock_art_stream.py` помогают прогонять `error_502`, `delay`, `partial` для постоянного комплаенса.

## Лимиты и директивы
- Attachment запрашивается только для mime из списка (`image/png`, `image/jpeg`, `text/plain`, `application/json`) и проверяется по magic signature.
- Spool массивно очищается после `UI_PROXY_SPOOL_RETENTION` (24 ч), индексы покрывают `event_id`, `status`, `created_at` и DLQ по `event_id`.
- При повторных неудачах (status `retryable`, `permanent`) UI Proxy отправляет per-event статус и, при необходимости, перемещает событие в `spool_dlq`.
- `UI Proxy` redacts Authorization/API-key теги (см. `HeaderSanitizer`), поэтому при логировании Authorization заменяется на `***REDACTED***`.

## Полезные команды
```bash
# Перезапустить все сервисы
./run.sh
# Проверить статус systemd user-сервисов
systemctl --user status my_langgraph.service my_langgraph_ui_proxy.service my_langgraph_react_ui.service
journalctl --user -u my_langgraph_ui_proxy.service --since today
# Запустить нагрузочный сценарий (502/delay/partial)
REGART_INGEST_TOKEN=... UI_PROXY_PORT=8090 python scripts/load_test.py --simulate error_502 --events 50
# Проверить mock Art + SSE
python scripts/full_cycle_test.py
```
