# CHECKLIST: REGART ↔ Art — готовность REGART к полному подключению Art

Правило: **делаем строго по шагам**. Нельзя переходить к шагу N+1, пока не закрыт шаг N.

---

## 0) Контракт и инварианты (фиксируем до реализации)

1. [x] Создать `docs/integration/REGART_ART_CONTRACT.md`  
   **Должно включать (минимум):**
   - RawEvent поля + `schema_version`
   - **Back/Forward compat**: unknown fields policy, upgrade/downgrade ожидания
   - Idempotency (`event_id`) + (опц.) `content_hash`
   - Ordering политика (важно/неважно; если важно — `sequence_id`)
   - Ingest+Ack **с partial-ack (per-event status)**
   - Retry policy (числа + jitter) + timeout policy
   - DLQ (когда, после скольких попыток, как алертить)
   - Stream (SSE) + cursor/resume
   - Attachments: лимиты/поведение/безопасность (mime, AV, XSS)
   - CORS (если UI/Proxy на разных origin)
   - Логирование без секретов
   - `observability_gap.*`  
   **Проверка:**
   ~~~bash
   test -f docs/integration/REGART_ART_CONTRACT.md && \
   rg -n "RawEvent|schema_version|unknown|extra|upgrade|downgrade|Idempotency|content_hash|Ordering|sequence_id|partial|Ack|Retry|Timeout|DLQ|Stream|cursor|Attachments|CORS|log|secret|observability_gap" docs/integration/REGART_ART_CONTRACT.md
   ~~~

2. [x] Зафиксировать политику **unknown fields** (обратная совместимость)  
   **Требование:** валидаторы **игнорируют незнакомые поля** (не падают).  
   - UI (zod): `.strip()` или `.passthrough()` (запрещено `.strict()` для входящих событий)  
   - UI Proxy (pydantic): `extra="ignore"`  
   **Проверка:** раздел “Compatibility / Unknown fields” в контракте.

3. [x] Зафиксировать **partial-ack формат** (обязательный пример JSON)  
   **Требование:** per-event статусы вида: `{event_id, status, retry_after_ms?, reason?, canonical_event_id?}`  
   **Проверка:** пример присутствует в контракте.

4. [x] Зафиксировать **Retry/Timeout policy** (конкретные числа)  
   **Рекомендуемая фиксация (пример, можно поменять, но один раз):**
   - `max_retries = 8`
   - `base_delay_ms = 250`
   - `max_delay_ms = 30000`
   - `delay = min(max_delay, base*2^i) + jitter(0..250ms)`  
   - после успеха backoff **сбрасывается**
   - UI Proxy timeouts (httpx): connect=3s, read=10s, write=10s (или единый 10s)  
   **Проверка:** раздел “Retry & Timeouts” в контракте.

---

## 1) RawEvent формат + версионирование схемы (UI + UI Proxy)

5. [x] UI: добавить RawEvent schema + normalize  
   **Технология:** zod  
   **Артефакты:**  
   - `ui/src/obs/rawEvent.schema.js` (zod object **не strict**)  
   - `ui/src/obs/rawEvent.normalize.js`  
   **Проверка:**
   ~~~bash
   test -f ui/src/obs/rawEvent.schema.js && test -f ui/src/obs/rawEvent.normalize.js
   ~~~

6. [x] UI Proxy: pydantic модели RawEvent (**extra=ignore**)  
   **Артефакт:** `agent/src/react_agent/obs_models.py`  
   **Проверка:**
   ~~~bash
   test -f agent/src/react_agent/obs_models.py && rg -n "extra\\s*=\\s*\"ignore\"|ConfigDict\\(.*extra" agent/src/react_agent/obs_models.py
   ~~~

7. [x] Добавить `schema_version` в событие + upgrade-конвертеры  
   **Артефакты:**  
   - `ui/src/obs/rawEvent.upgrade.js`  
   - `agent/src/react_agent/obs_upgrade.py`  
   **Проверка:** файлы существуют.

8. [x] Добавить тест “**v2 событие валидируется схемой v1** (unknown fields ignored)”  
   **Проверка:** unit-тесты зелёные (см. шаги 57–59).

9. [x] Добавить тест “**rolling upgrade**: старая версия → пишет в spool/outbox → новая версия доставляет”  
   **Проверка:** интеграционный/сквозной тест зелёный (см. шаги 61–62).

---

## 2) Identity/Auth/Tenancy (секреты не в браузере)

10. [x] Реализовать `client_id` server-side (UI Proxy) + `session_id` в UI  
    **Проверка:** UI получает `client_id` как non-secret; секретов нет в UI.

11. [x] Защитить ingress: `/ui/ingest/events` и `/ui/ingest/attachments` (bearer token + allowlist)  
    **Проверка:** pytest: без токена 401/403, с токеном 200 (см. шаг 60).

12. [x] Гарантировать: REGART→Art авторизация добавляется **только** в UI Proxy  
    **Проверка:**
    ~~~bash
    rg -n "Authorization|ART_.*TOKEN|api[_-]?key" ui/src || true
    ~~~

---

## 3) Корреляция browser ↔ ui_proxy ↔ upstream

13. [x] UI: генерировать `trace_id/span_id/request_id` и прокидывать заголовками  
    **Проверка:** unit-тест + grep (см. шаг 58).

14. [x] UI Proxy: прокидывать корреляцию в upstream (LangGraph/Providers)  
    **Проверка:** `pytest -q agent/tests/integration_tests/test_ui_art_ingest.py::test_art_ingest_preserves_correlation_headers` (mock Art проверяет `X-Trace-Id/X-Span-Id/X-Request-Id`).

---

## 4) Единый сетевой слой UI + запрет прямого fetch

15. [x] Создать `ui/src/obs/httpClient.js` и перевести UI на него  
    **Проверка:**
    ~~~bash
    rg -n "fetch\\(" ui/src | rg -v "obs/httpClient\\.js|node_modules" || true
    ~~~

16. [x] Инструментировать сеть `network.request/response/error` (RawEvent)  
    **Проверка:** unit + e2e (см. шаги 58–59).

17. [x] Ввести **таймауты** на UI-вызовы (AbortController)  
    **Проверка:** тест имитирует “вечный” ответ → запрос обрывается, событие retryable (см. шаг 59).

---

## 5) Level0/Level1 → RawEvent + запись в Outbox

18. [x] Level0 (до React) пишет RawEvent и кладёт в outbox  
    **Проверка:** e2e “ошибка до React” (см. шаг 59).

19. [x] UiErrorCore выдаёт только RawEvent (или строгий маппинг)  
    **Проверка:** unit-тест формы события.

---

## 6) Outbox UI (IndexedDB): размер/порядок/partial-ack/DLQ/id-unique

20. [x] Реализовать outbox в IndexedDB  
    **Технология:** Dexie  
    **Артефакты:** `ui/src/obs/outbox.db.js`, `ui/src/obs/outbox.js`  
    **Проверка:** перезагрузка не теряет очередь.

21. [x] Оптимизация outbox: **lazy/paged load**, лимиты (max_count/max_bytes/max_age), батч-лимит  
    **Проверка:** unit-тест: загрузка страницы не читает всю базу; батч ограничен.

22. [x] **Ordering (если важен):** хранить `sequence_id` (монотонный per session_id)  
    **Проверка:** unit-тест: sequence возрастает и отправка идёт по нему.

23. [x] Если ordering важен: отправка **строго последовательно** для одной session (без параллельных flush)  
    **Проверка:** unit-тест “двойной flush” не запускает 2 отправки.

24. [x] Реализовать обработку **partial-ack** (per-event statuses)  
    - accepted → ack & delete  
    - retryable → остаётся  
    - rejected permanent → DLQ  
    **Проверка:** unit-тест на разбор ответа + действия.

25. [x] Реализовать **DLQ в UI** + событие `observability_gap.dlq_enqueued`  
    **Проверка:** после N неудач событие уходит в DLQ.

26. [x] **Мониторинг DLQ**:  
    - метрика `dlq_size` (в UI можно как счетчик, в proxy — prometheus)  
    - событие `observability_gap.dlq_non_empty` при первом появлении и если > 15 минут не пуст  
    **Проверка:** unit/integration тест: DLQ → gap-событие.

27. [x] Усилить уникальность `event_id` + (опц.) `content_hash`  
    **Требование:** генератор устойчив к конкуренции (workers/вкладки).  
    **Проверка:** тест: 1e5 ids + параллельная генерация без коллизий (см. шаг 58–59).

---

## 7) UI → UI Proxy → Art: transport + spool + dedup + DLQ + timeouts

28. [x] UI отправляет батчи в UI Proxy (`/ui/art/ingest`) без секретов  
    **Проверка:** network события показывают запросы только на UI Proxy.

29. [x] UI Proxy форвардит в Art с **timeout policy** (connect/read/write)  
    **Проверка:** `pytest -q agent/tests/integration_tests/test_ui_art_ingest.py::test_art_read_timeout_respects_policy` (Art “зависает” → UI Proxy возвращает 504 + retryable).

30. [x] UI Proxy поддерживает **partial-ack** (не переотправлять успешные)  
    **Проверка:** интеграционный тест на mixed statuses.

31. [x] Server-spool (SQLite) для оффлайна Art  
    **Технология:** SQLite + aiosqlite, WAL  
    **Проверка:** Art off → события пишутся в sqlite.

32. [x] Оптимизация SQLite: индексы + очистка acked + политика retention  
    **Требование индексов минимум:** `event_id`, `status`, `created_at`, `session_id`, `sequence_id` (если есть)  
    **Проверка:** миграция/SQL создаёт индексы (см. шаг 60).

33. [x] UI Proxy **dedup** по `event_id` (и `source`) до отправки в Art  
    **Требование:** уникальный индекс/проверка в spool: повтор → вернуть ack “уже принято”, не слать повторно.  
    **Проверка:** тест: два одинаковых event_id → в mock Art уходит один (см. шаг 61).

34. [x] UI Proxy DLQ (server-side) + алертинг как в шаге 26  
    **Проверка:** событие попадает в dlq таблицу, метрика растёт, gap-событие генерируется.

35. [x] Graceful degradation при повреждении SQLite spool  
    **Требование:** при `sqlite3.DatabaseError` → режим “in-memory spool” + `observability_gap.spool_corrupted` + попытка пересоздать БД/ротация файла.  
    **Проверка:** тест: повреждённый файл sqlite → сервис жив, пишет в память, сообщает gap (см. шаг 60).

36. [x] Миграции схемы SQLite spool  
    **Требование:** версия схемы + миграции (Alembic или простые ALTER-скрипты).  
    **Проверка:** тест: накопить события на старой схеме → миграция → данные не потеряны (см. шаг 60).

---

## 8) Ingress внешних событий + attachments: безопасность и поведение при превышении

37. [x] `/ui/ingest/events`: auth + pydantic validation + redaction  
    **Проверка:** `pytest -q agent/tests/integration_tests/test_ui_art_ingest.py::test_ingest_events_requires_auth agent/tests/integration_tests/test_ui_art_ingest.py::test_ingest_events_validation_error agent/tests/integration_tests/test_ui_art_ingest.py::test_ingest_events_redacts_sensitive_fields`

38. [x] `/ui/ingest/attachments`: allowlist MIME + magic-bytes check + safe filenames + no inline render  
    **Проверка:** `pytest -q agent/tests/integration_tests/test_ui_art_ingest.py::test_ingest_attachments_rejects_magic_mismatch agent/tests/integration_tests/test_ui_art_ingest.py::test_ingest_attachments_rejects_path_traversal`

39. [x] Поведение при слишком большом attachment  
    **Требование:** >max_bytes → HTTP 413 + `observability_gap.attachment_too_large`  
    **Проверка:** `pytest -q agent/tests/integration_tests/test_ui_art_ingest.py::test_ingest_attachments_rejects_large_files`

40. [x] Антивирус/сканирование вложений (ClamAV или внешний scanner)  
    **Проверка:** `pytest -q agent/tests/integration_tests/test_ui_art_ingest.py::test_ingest_attachments_detects_malware`

---

## 9) Provider Gateway (облака/модели): таймауты, редактирование, “замена транспорта”

41. [ ] Единый Provider Gateway API в UI Proxy (UI не ходит в облака)  
42. [ ] Таймауты всех исходящих provider вызовов в UI Proxy  
43. [ ] Инструментация provider.* событий + редактирование (и в событиях, и в логах)  
44. [ ] Переключатель транспорта A/B (сейчас → providers; потом → Art Gateway)  
    **Проверка:** интеграционные тесты (см. шаг 60–61).

---

## 10) Downlink Art → REGART (SSE): ordering/resume

45. [ ] SSE downlink через UI Proxy `/ui/art/stream`  
46. [ ] cursor/resume (хранение cursor)  
47. [ ] Ordering для downlink: если Art даёт sequence/cursor порядок — UI применяет/сортирует; иначе best-effort + gap при аномалиях  
    **Проверка:** сквозной тест (см. шаг 61).

---

## 11) Graph instrumentation + snapshots (исходный баг)

48. [ ] graph события: fetch/layout/render/empty  
49. [ ] snapshot/bundle при empty/0-size + attachment flow  
    **Проверка:** e2e (см. шаг 59).

---

## 12) Multi-tab coordination: BroadcastChannel + fallback

50. [ ] lock через BroadcastChannel  
51. [ ] fallback через localStorage TTL+heartbeat (если BroadcastChannel нет)  
    **Проверка:** unit-тесты + имитация отсутствия BroadcastChannel.

---

## 13) CORS и логирование без секретов (эксплуатационные обязательства)

52. [ ] Настроить CORS UI Proxy (allow origins, методы, заголовки, preflight)  
    **Проверка:** интеграционный тест OPTIONS preflight (см. шаг 60).

53. [ ] Фильтр логов UI Proxy: маскировать Authorization/X-API-Key и т.п.  
    **Проверка:** тест: запрос с секретом → секрет не появляется в логах (см. шаг 60).

---

## 14) Нефункциональные тесты (стресс/сеть/перегрузка)

54. [ ] “Art offline долго”: spool заполняется, потом восстанавливается и очищается  
55. [ ] “плохая сеть”: потери/задержка/таймауты (toxiproxy или tc netem)  
56. [ ] “высокий RPS”: outbox/spool лимиты, CPU/mem, нет утечек  
    **Проверка:** отдельные тест-прогоны (см. шаг 60–61).

---

## 15) Автотесты (конкретные места и команды)

### UI (Vitest + Playwright)
57. [ ] Подключить Vitest + скрипт `npm -C ui test`  
58. [ ] Unit: RawEvent schema (unknown fields), upgrade/downgrade, id generator (в т.ч. параллельно), outbox (sequence/partial-ack/DLQ), httpClient timeout  
59. [ ] Playwright E2E: ошибка до React; graph empty → snapshot/attachment  
    **Проверка:** `npm -C ui test` и `npm -C ui run e2e` зелёные.

### UI Proxy (pytest)
60. [ ] pytest integration: ingest/events+attachments (auth, mime, 413, AV, CORS), log redaction, spool (indexes/migrations/corruption), partial-ack, dedup, provider timeouts/correlation  
    **Проверка:** `pytest -q` зелёный.

### Сквозной E2E “полный цикл” (обязательный)
61. [ ] Поднять mock Art (ingest + partial-ack + SSE stream) и прогнать:  
    UI → outbox → UI Proxy → mock Art ingest → mock Art SSE downlink → UI отображение  
    **Проверка:** один тест проходит всю цепочку.

### Rolling upgrade (обязательный)
62. [ ] Сценарий: “старая версия” пишет в spool/outbox → обновление → доставка без потерь и падений на schema_version/unknown fields  
    **Проверка:** отдельный тест/скрипт.

---

## 16) Эксплуатационная документация (обязательное завершение)

63. [ ] README/ops: переменные окружения, метрики (в т.ч. dlq_size), алерты, лимиты, retry/timeout policy  
64. [ ] Runbook: “DLQ не пуст”, “spool corrupted”, “attachment blocked”, “Art offline” + команды диагностики  
    **Проверка:** файлы существуют в `docs/ops/`.

---

## 17) Итоговый DoD

65. [ ] Контракт содержит: unknown fields policy, partial-ack format, retry/timeout numbers, DLQ, ordering.  
66. [ ] Реализованы: outbox+spool, partial-ack, dedup, DLQ+алерты, timeouts, attachment security+413+AV.  
67. [ ] Пройдены: сквозной E2E полный цикл, rolling upgrade, нефункциональные тесты.
