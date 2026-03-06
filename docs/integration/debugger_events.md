# Debugger Event Model and Correlation

## Source of truth
- `CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md`
- `ui/src/debugger/README.md`
- `docs/integration/REGART_ART_CONTRACT.md`

## Event classes
1. UI runtime events (React/UI failures, user actions).
2. Run stream events (LangGraph execution lifecycle).
3. Proxy transport events (ingest/stream retries, timeout, gap).
4. Art feedback events (snapshot/stream acknowledgements, observability gaps).

## Correlation keys
- `trace_id`
- `run_id`
- `node_id`
- `event_id`
- `sequence_id` (session ordering)

## Rule
Every actionable debugger message must carry correlation context sufficient for replay or drill-down.
