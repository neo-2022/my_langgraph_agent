/**
 * Debugger Level 1 Core (минимальный)
 * - UiError контракт
 * - ring buffer (фиксированный размер)
 * - pushError / subscribe
 *
 * Важно:
 * - без UI и без "магических" маппингов (всё приходит как строки/объекты)
 * - пригодно для источников: UI/React/Run/API/UI Proxy/Graph/Tools/Level0 bridge
 */

/** @typedef {"info"|"warn"|"error"|"fatal"} UiSeverity */

/**
 * @typedef {Object} UiError
 * @property {string} id
 * @property {string} ts            ISO timestamp
 * @property {UiSeverity} severity
 * @property {string} source        например: "ui" | "react" | "run" | "api" | "proxy" | "graph" | "tools" | "dbg0" | ...
 * @property {string} message
 * @property {string} [code]        краткий код/ключ (если есть)
 * @property {string} [stack]
 * @property {any}    [details]     произвольные данные (объект/строка/число)
 * @property {any}    [cause]       оригинальная ошибка/причина (если есть)
 * @property {Record<string, any>} [context]  произвольный контекст
 */

/**
 * Безопасно делает строку.
 * @param {any} v
 */
function toStr(v) {
  try {
    if (v == null) return "";
    return typeof v === "string" ? v : String(v);
  } catch {
    return "";
  }
}

/**
 * ISO timestamp
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Генерация id без внешних зависимостей.
 */
function genId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  // fallback: достаточно для UI (не крипто)
  return `e_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * Нормализация "ошибкоподобного" объекта в UiError.
 * @param {any} input
 * @param {Partial<UiError>} [overrides]
 * @returns {UiError}
 */
export function normalizeUiError(input, overrides = {}) {
  const o = overrides || {};
  const severity = /** @type {UiSeverity} */ (o.severity || "error");
  const source = toStr(o.source) || "ui";

  // message/stack пытаемся вытащить из input
  let message = toStr(o.message);
  let stack = toStr(o.stack);

  if (!message) {
    if (input && typeof input === "object") {
      message = toStr(input.message) || toStr(input.reason) || toStr(input.name) || "";
    } else {
      message = toStr(input);
    }
  }
  if (!stack && input && typeof input === "object") {
    stack = toStr(input.stack);
  }

  const err = {
    id: toStr(o.id) || genId(),
    ts: toStr(o.ts) || nowIso(),
    severity,
    source,
    message: message || "(no message)",
    code: toStr(o.code) || undefined,
    stack: stack || undefined,
    details: o.details !== undefined ? o.details : undefined,
    cause: o.cause !== undefined ? o.cause : (input instanceof Error ? input : undefined),
    context: o.context && typeof o.context === "object" ? o.context : undefined,
  };

  return err;
}

/**
 * @callback UiErrorListener
 * @param {UiError} err
 * @param {{size:number, dropped:number}} meta
 */

/**
 * Минимальный Core: фиксированный буфер + подписки.
 */
export class UiErrorCore {
  /**
   * @param {{capacity?: number}} [opts]
   */
  constructor(opts = {}) {
    this.capacity = Math.max(10, Number(opts.capacity || 200));
    /** @type {UiError[]} */
    this.buf = [];
    /** @type {Set<UiErrorListener>} */
    this.listeners = new Set();
    this.dropped = 0;
  }

  /**
   * @returns {{capacity:number, size:number, dropped:number}}
   */
  stats() {
    return { capacity: this.capacity, size: this.buf.length, dropped: this.dropped };
  }

  /**
   * @param {UiError|any} input
   * @param {Partial<UiError>} [overrides]
   * @returns {UiError}
   */
  push(input, overrides = {}) {
    const err = normalizeUiError(input, overrides);

    if (this.buf.length >= this.capacity) {
      // drop oldest
      this.buf.shift();
      this.dropped += 1;
    }
    this.buf.push(err);

    const meta = { size: this.buf.length, dropped: this.dropped };
    for (const fn of this.listeners) {
      try {
        fn(err, meta);
      } catch {
        // слушатели не должны валить core
      }
    }

    return err;
  }

  /**
   * @param {UiErrorListener} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * @param {{limit?: number}} [opts]
   * @returns {{items: UiError[], stats: {capacity:number,size:number,dropped:number}}}
   */
  snapshot(opts = {}) {
    const limit = Math.max(1, Number(opts.limit || 50));
    const items = this.buf.slice(-limit);
    return { items, stats: this.stats() };
  }

  clear() {
    this.buf = [];
    this.dropped = 0;
  }
}

/**
 * Singleton Core (для простого подключения в App/Graph/Run)
 */
let __core = null;

/**
 * @param {{capacity?: number}} [opts]
 * @returns {UiErrorCore}
 */
export function getUiErrorCore(opts = {}) {
  if (__core) return __core;
  __core = new UiErrorCore(opts);
  return __core;
}
