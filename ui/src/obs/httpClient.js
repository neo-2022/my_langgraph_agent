import { buildCorrelationHeaders, createCorrelationContext } from "./correlation.js";

const DEFAULT_TIMEOUT_MS = 10000;

function resolveUrl(path, baseUrl) {
  if (typeof path !== "string") return "";
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  if (typeof baseUrl === "string" && baseUrl) {
    const cleanedBase = baseUrl.replace(/\/+$/, "");
    return `${cleanedBase}/${path.replace(/^\/+/, "")}`;
  }
  return path.startsWith("/") ? path : `/${path}`;
}

function logNetwork(payload) {
  if (typeof window === "undefined") return;
  try {
    window.__DBG0__?.pushNetwork(payload);
  } catch {
    // ignore
  }
}

function getGlobalClientId() {
  if (typeof window === "undefined") return undefined;
  return window.__REGART_CLIENT_ID__;
}

export async function request(path, options = {}) {
  const opts = { method: "GET", timeout: DEFAULT_TIMEOUT_MS, ...options };
  const method = (opts.method || "GET").toUpperCase();
  const timeout = Number.isFinite(Number(opts.timeout)) ? Number(opts.timeout) : DEFAULT_TIMEOUT_MS;
  const controller = opts.signal ? null : new AbortController();
  const signal = opts.signal || controller?.signal;
  const correlationContext = createCorrelationContext(opts.correlation);
  const correlationHeaders = buildCorrelationHeaders(correlationContext);
  const baseUrl = opts.baseUrl || "";
  const url = resolveUrl(path, baseUrl);

  const clientId = opts.clientId || getGlobalClientId();
  const requestHeaders = {
    ...(opts.headers || {}),
    ...correlationHeaders,
  };
  if (clientId) {
    requestHeaders["X-Client-Id"] = clientId;
  }

  let body = opts.body;
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  if (body != null && !isFormData && opts.json !== false) {
    body = JSON.stringify(body);
    requestHeaders["Content-Type"] = requestHeaders["Content-Type"] || "application/json";
  }

  const getNow = () => {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  };
  const start = getNow();
  const logCtx = { correlation: correlationContext, client_id: clientId };
  logNetwork({
    ts: new Date().toISOString(),
    method,
    url,
    request: opts.body,
    ctx: logCtx,
  });

  let timer;
  if (timeout && controller) {
    timer = setTimeout(() => controller.abort(), Math.max(10, timeout));
  }

  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body,
      signal,
    });

    const duration_ms = Math.round(performance.now() - start);
    let responseText;
    try {
      responseText = await response.clone().text();
    } catch {
      responseText = undefined;
    }

    logNetwork({
      ts: new Date().toISOString(),
      method,
      url,
      duration_ms,
      status: response.status,
      ok: response.ok,
      response: responseText,
      ctx: logCtx,
    });

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      error.response = response;
      error.responseText = responseText;
      throw error;
    }

    if (opts.parseAs === "text") {
      return response.text();
    }

    if (opts.parseAs === "blob") {
      return response.blob();
    }

    if (opts.parseAs === "raw") {
      return response;
    }

    return response.json();
  } catch (error) {
    const duration_ms = Math.round(getNow() - start);
    logNetwork({
      ts: new Date().toISOString(),
      method,
      url,
      duration_ms,
      error: error?.message,
      ctx: logCtx,
    });
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export const httpClient = {
  get(path, opts = {}) {
    return request(path, { ...opts, method: "GET" });
  },
  post(path, opts = {}) {
    return request(path, { ...opts, method: "POST" });
  },
  put(path, opts = {}) {
    return request(path, { ...opts, method: "PUT" });
  },
  patch(path, opts = {}) {
    return request(path, { ...opts, method: "PATCH" });
  },
  delete(path, opts = {}) {
    return request(path, { ...opts, method: "DELETE" });
  },
};

export async function stream(path, options = {}) {
  const opts = { method: "GET", ...options };
  const method = (opts.method || "GET").toUpperCase();
  const baseUrl = opts.baseUrl || "";
  const url = resolveUrl(path, baseUrl);
  const correlationContext = createCorrelationContext(opts.correlation);
  const correlationHeaders = buildCorrelationHeaders(correlationContext);
  const headers = { ...(opts.headers || {}), ...correlationHeaders };
  const clientId = opts.clientId || getGlobalClientId();
  const controller = opts.signal ? null : new AbortController();
  const signal = opts.signal || controller?.signal;
  logNetwork({
    ts: new Date().toISOString(),
    method,
    url,
    request: opts.body,
    ctx: { correlation: correlationContext, client_id: clientId },
  });

  const response = await fetch(url, {
    method,
    headers: clientId ? { ...headers, "X-Client-Id": clientId } : headers,
    body: opts.body,
    signal,
  });

  logNetwork({
    ts: new Date().toISOString(),
    method,
    url,
    status: response.status,
    ok: response.ok,
    ctx: { correlation: correlationContext, client_id: clientId },
  });

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.response = response;
    throw error;
  }

  return response;
}
