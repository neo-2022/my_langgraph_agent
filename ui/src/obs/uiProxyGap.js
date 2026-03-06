import { pushObservabilityGap } from "./outbox.js";

const UI_PROXY_STATUS_ENDPOINT = "/ui/ui-proxy/status";
const DEFAULT_BACKOFF_MS = 1500;

function normalizeStatus(value) {
  if (value == null) return "unknown";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ensureTraceId(value) {
  try {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return `trace_ui_proxy_${Date.now()}`;
}

export function notifyUiProxyUnavailable({ status, error, retryCount = 0, backoffMs = DEFAULT_BACKOFF_MS, trace_id }) {
  const payload = {
    endpoint: UI_PROXY_STATUS_ENDPOINT,
    status: normalizeStatus(status),
    error: typeof error === "string" ? error : error?.message || "",
    retry_count: Number.isFinite(Number(retryCount)) ? Number(retryCount) : 0,
    backoff_ms: Number.isFinite(Number(backoffMs)) ? Number(backoffMs) : DEFAULT_BACKOFF_MS,
    trace_id: ensureTraceId(trace_id),
  };
  pushObservabilityGap("observability_gap.ui_proxy_unavailable", payload);
}
