import { pushObservabilityGap } from "./outbox.js";

const STORAGE_KEY = "regart_art_stream_cursor";
const DEFAULT_BASE_URL = import.meta.env.VITE_UI_PROXY_BASE_URL || "http://127.0.0.1:8090";
const STREAM_PATH = "/ui/art/stream";

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function loadCursor() {
  try {
    if (typeof window === "undefined") return "";
    return window.localStorage?.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function saveCursor(cursor) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage?.setItem(STORAGE_KEY, cursor);
  } catch {}
}

function pushDebugEvent(payload) {
  try {
    if (typeof window === "undefined") return;
    const target = window.__DBG0__;
    if (!target || typeof target.pushEvent !== "function") return;
    target.pushEvent({
      name: "art_stream_event",
      origin: "art_stream",
      level: "info",
      ts: new Date().toISOString(),
      payload,
    });
  } catch {}
}

function parseSequence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (Number.isInteger(n)) return n;
  return Math.floor(n);
}

class ArtStreamClient {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.cursor = loadCursor();
    this.lastSequence = undefined;
    this.retryAttempt = 0;
    this.eventSource = null;
    this.reconnectTimer = null;
    this.stopped = false;
  }

  start() {
    if (this.stopped) return;
    this._connect();
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("beforeunload", this._handleUnload);
    }
  }

  stop() {
    this.stopped = true;
    this._cleanup();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (typeof window !== "undefined" && window.removeEventListener) {
      window.removeEventListener("beforeunload", this._handleUnload);
    }
  }

  _handleUnload = () => {
    this.stop();
  };

  _connect() {
    if (this.stopped) return;
    this._cleanup();
    const url = this._buildUrl();
    let source;
    try {
      source = new EventSource(url, { withCredentials: false });
    } catch (error) {
      this._scheduleReconnect();
      pushObservabilityGap("observability_gap.stream_closed", {
        retry_after_ms: this._nextRetryDelay(),
        error: String(error?.message || error),
      });
      return;
    }

    this.eventSource = source;
    source.onopen = () => {
      this.retryAttempt = 0;
    };
    source.onmessage = (event) => this._handleMessage(event);
    source.onerror = () => this._handleError();
  }

  _cleanup() {
    if (this.eventSource) {
      this.eventSource.onopen = null;
      this.eventSource.onmessage = null;
      this.eventSource.onerror = null;
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  _buildUrl() {
    try {
      const url = new URL(STREAM_PATH, this.baseUrl);
      if (this.cursor) {
        url.searchParams.set("cursor", this.cursor);
      }
      return url.toString();
    } catch {
      return `${this.baseUrl}${STREAM_PATH}`;
    }
  }

  _handleMessage(event) {
    const payload = safeJsonParse(event.data);
    if (!payload) {
      pushDebugEvent({ note: "invalid JSON", raw: event.data });
      return;
    }

    const cursor = typeof payload.cursor === "string" ? payload.cursor : undefined;
    if (cursor) {
      this.cursor = cursor;
      saveCursor(cursor);
    }

    const sequence = parseSequence(payload.sequence_id ?? payload.sequence ?? payload.seq);
    if (sequence != null) {
      if (this.lastSequence != null && sequence <= this.lastSequence) {
        pushObservabilityGap("observability_gap.stream_order_gap", {
          sequence_id: sequence,
          last_sequence_id: this.lastSequence,
          cursor,
        });
      }
      this.lastSequence = sequence;
    }

    pushDebugEvent(payload);
  }

  _handleError() {
    if (this.stopped) return;
    this._cleanup();
    const delay = this._nextRetryDelay();
    pushObservabilityGap("observability_gap.stream_closed", { retry_after_ms: delay });
    this._scheduleReconnect(delay);
  }

  _scheduleReconnect(delay) {
    if (this.stopped || this.reconnectTimer) return;
    const wait = delay ?? this._nextRetryDelay();
    const scheduler =
      typeof window !== "undefined" && typeof window.setTimeout === "function"
        ? window.setTimeout
        : setTimeout;
    this.reconnectTimer = scheduler(() => {
      this.reconnectTimer = null;
      this._connect();
    }, wait);
  }

  _nextRetryDelay() {
    const base = 1000;
    const max = 12000;
    const next = Math.min(max, base * Math.pow(2, this.retryAttempt));
    this.retryAttempt = Math.min(10, this.retryAttempt + 1);
    return Math.max(500, Math.round(next));
  }
}

export function startArtStream(options = {}) {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return { stop: () => {} };
  }
  const client = new ArtStreamClient(options.baseUrl);
  client.start();
  return client;
}

export { ArtStreamClient };
