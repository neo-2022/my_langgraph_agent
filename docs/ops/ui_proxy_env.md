# UI Proxy Environment Variables

## Source of truth
- `README.md`
- `run.sh`
- `systemd/my_langgraph_ui_proxy.service`
- `CHECKLIST_REGART_ART_INTEGRATION.md`

## Required
- `ART_STREAM_URL`: Art/Mock SSE URL for `/ui/art/stream`.
- `LANGGRAPH_SYSTEMD_SERVICE`: user service name used for controlled restarts.

## Optional (deployment-specific)
- `ART_INGEST_URL`: explicit ingest URL when different from stream host.
- `UI_PROXY_PORT`: bind port override for local deployments.
- `LOG_LEVEL`: proxy log verbosity.

## Safety rules
1. Secrets are never logged in clear text.
2. Environment must be reflected in runbook/ops docs before production rollout.
3. Any new env var requires checklist and contract review update.
