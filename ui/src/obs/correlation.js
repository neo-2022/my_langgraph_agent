const ID_PREFIXES = {
  trace: "trace",
  span: "span",
  request: "req",
};

function generateId(prefix = "id") {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // ignore
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

let activeTraceId = null;

export function getTraceId() {
  if (!activeTraceId) {
    activeTraceId = generateId(ID_PREFIXES.trace);
  }
  return activeTraceId;
}

export function resetTraceId() {
  activeTraceId = generateId(ID_PREFIXES.trace);
  return activeTraceId;
}

export function createSpanId() {
  return generateId(ID_PREFIXES.span);
}

export function createRequestId() {
  return generateId(ID_PREFIXES.request);
}

export function createCorrelationContext(overrides = {}) {
  const trace_id = overrides.trace_id || getTraceId();
  const span_id = overrides.span_id || createSpanId();
  const request_id = overrides.request_id || createRequestId();
  return { trace_id, span_id, request_id };
}

export function buildCorrelationHeaders(context = {}) {
  const ctx = createCorrelationContext(context);
  const headers = {
    "X-Trace-Id": ctx.trace_id,
    "X-Span-Id": ctx.span_id,
    "X-Request-Id": ctx.request_id,
  };
  return headers;
}
