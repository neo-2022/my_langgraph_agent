# Runbook: критические ситуации REGART ↔ Art

## 1. DLQ не пуст (`spool_dlq` > 0)
**Как обнаружить**
- `observability_gap.dlq_non_empty` появляется в логах UI Proxy/Level0 (повторный gap через 15 мин).
- `observability_gap.dlq_enqueued` показывает `reason`, `event_id`, `size`.
- При ручном осмотре: `sqlite3 ~/.local/share/regart/ui_proxy_spool.db "SELECT COUNT(*) FROM spool_dlq;"`.

**Что делать**
1. Убедиться, что Art доступен (`curl http://127.0.0.1:7331/openapi.json`).
2. Перезапустить UI Proxy и LangGraph через systemd (см. раздел `Полезные команды`).
3. Если backlog большой, вручную осмотреть `spool_dlq` (вложения, ошибки) и удалить записи с `DELETE FROM spool_dlq WHERE event_id='...';`.
4. При необходимости — поправить `ART_INGEST_URL` / токен и дождаться новой доставки.

## 2. Спул повреждён (`sqlite3.DatabaseError` → `observability_gap.spool_corrupted`)
**Как обнаружить**
- В логах UI Proxy: `Spool DB corrupted, falling back to in-memory queue`.
- `journalctl --user -u my_langgraph_ui_proxy.service` → `sqlite3.DatabaseError`.

**Что делать**
1. Остановить UI Proxy: `systemctl --user stop my_langgraph_ui_proxy.service`.
2. Сделать бэкап файл `~/.local/share/regart/ui_proxy_spool.db` (если нужен лог): `cp ...{.bak}`.
3. Удалить/переименовать файл (чтобы sqlite пересоздался) и проверить права на каталог.
4. Запустить снова `systemctl --user start my_langgraph_ui_proxy.service` и наблюдать gap: при отсутствии файла, queue работает.
5. Если требуется восстановить события, можно прочитать `spool_events` и повторно отправить события вручную.

## 3. Вложение заблокировано (`attachment scanner`) или размер превышен
**Как обнаружить**
- Ответ `413` при `POST /ui/attachments`, `observability_gap.attachment_blocked` (с `reason` либо `size`).
- Лог в UI Proxy: `attachment scanner error` или `attachment blocked`.

**Что делать**
1. Проверить заголовки (mime + размер) и `ATTACHMENT_MAX_BYTES`; при необходимости увеличить переменную.
2. Если включён сканер, запустить команду вручную (`ATTACHMENT_SCANNER_CMD`) с `--log` и убедиться, что `clamd`/freshclam доступны.
3. При ложных детекциях временно отключить `ATTACHMENT_SCANNER_CMD` (пусть `None`).
4. После изменения параметров перезапустить UI Proxy и попробовать загрузить файл снова.

## 4. Art недоступен (timeout/connect errors)
**Как обнаружить**
- `observability_gap.outbox_flush_failed` c `error` `HTTP 502/504`.
- UI Proxy возвращает `error_type=upstream_timeout` или `upstream_request_error`.
- `curl http://127.0.0.1:7331/openapi.json` → ошибка соединения.

**Что делать**
1. Проверить, запущен ли LangGraph: `systemctl --user status my_langgraph.service`.
2. Если сервис остановлен, запустить `systemctl --user restart my_langgraph.service` (или `LANGGRAPH_SYSTEMD_SERVICE` override). Если `LANGGRAPH_SYSTEMD_SERVICE` установлен, используйте его имя.
3. Убедиться, что LangGraph слушает `http://127.0.0.1:2024` (или `LANGGRAPH_BASE_URL`), и UI Proxy настроен на тот же `LANGGRAPH_BASE_URL`.
4. Проверить логи: `journalctl --user -u my_langgraph.service -n 200` и `journalctl --user -u my_langgraph_ui_proxy.service -n 200`.
5. Запустить `scripts/full_cycle_test.py` чтобы подтвердить, что цепочка работает.
