modified_at: 2026-03-12 20:50 MSK
Ручная сверка guide/docs: 2026-03-12 20:50 MSK

# REGART -> Art Bridge

## Source of truth
- `CHECKLIST_REGART_ART_INTEGRATION.md`
- `docs/integration/REGART_ART_CONTRACT.md`
- `README.md`

## Scope
Defines transport and operational bridge from REGART UI Proxy to Art ingest/stream APIs.

## Transport
1. Ingest uplink: `POST /ui/art/ingest` (proxy) -> Art ingest endpoint.
2. Stream downlink: `GET /ui/art/stream` SSE with cursor/resume.
3. Actions-only control path: `POST /api/v1/actions/execute` (no direct host process control from UI).

## Required env
- `ART_STREAM_URL` (default mock stream endpoint for local mode).
- `ART_INGEST_URL` (if split from stream host).
- `LANGGRAPH_SYSTEMD_SERVICE` for controlled restart target.

## Operational guarantees
- Outbox and spool persist events during upstream outages.
- `retryable` события не теряются: UI Proxy кладёт их в sqlite-spool и повторно отправляет после возврата `Art`.
- Background replay живёт внутри `my_langgraph_ui_proxy.service`, поэтому восстановление работает после reconnect, restart и reboot узла, а не только после ручного вмешательства.
- Partial ack is handled per-event (`accepted|retryable|rejected`).
- Observability gaps are emitted for delivery/order/security failures.
