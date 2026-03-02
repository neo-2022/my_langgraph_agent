/**
 * Debugger Level 1 Core (адаптер)
 *
 * Важно (по требованиям проекта):
 * - Level 0 = единственный сборщик/источник правды (window.__DBG0__)
 * - Level 1 (React UI) = "телевизор": показывает данные и отправляет записи в Level 0
 *
 * Поэтому этот файл:
 * - сохраняет старый API getUiErrorCore().push()/subscribe()/snapshot()
 * - но физически хранит/ведёт данные в Level 0 (если он доступен)
 * - локальный буфер — только fallback (если Level 0 почему-то не инициализирован)
 */

/** @typedef {"info"|"warn"|"error"|"fatal"} UiSeverity */

/**
 * @typedef {Object} UiError
 * @property {string} id
 * @property {string} ts
 * @property {string} scope
 * @property {UiSeverity} severity
 * @property {string} title
 * @property {string} message
 * @property {any} details
 * @property {string} [hint]
 * @property {any} [ctx]
 * @property {string} [dedupe_key]
 * @property {any} [actions]
 * @property {any} [location]
 * @property {any} [causes]
 * @property {any} [breadcrumbs]
 * @property {any} [related]
 */

function toStr(v) {
  try {
    if (v == null) return "";
    return typeof v === "string" ? v : String(v);
  } catch {
    return "";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function genId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return `e_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * Нормализация входа к UiError (совместимость со старым overrides.source).
 * Никакой "угадайки" — только поля, которые явно дали.
 * @param {any} input
 * @param {any} [overrides]
 * @returns {UiError}
 */
export function normalizeUiError(input, overrides = {}) {
  const o = overrides || {};
  const severity = /** @type {UiSeverity} */ (toStr(o.severity) || "error");

  // По требованиям — scope. Для совместимости принимаем и overrides.source.
  const scope = toStr(o.scope) || toStr(o.source) || "ui";

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

  const details =
    o.details !== undefined
      ? o.details
      : stack
      ? { stack }
      : input && typeof input === "object"
      ? input
      : { value: input };

  return {
    id: toStr(o.id) || genId(),
    ts: toStr(o.ts) || nowIso(),
    scope,
    severity,
    title: toStr(o.title) || "",
    message: message || "(no message)",
    details,
    hint: toStr(o.hint) || "",
    ctx: o.ctx && typeof o.ctx === "object" ? o.ctx : (o.context && typeof o.context === "object" ? o.context : undefined),
    dedupe_key: toStr(o.dedupe_key) || undefined,
    actions: Array.isArray(o.actions) ? o.actions : undefined,
    location: o.location && typeof o.location === "object" ? o.location : undefined,
    causes: Array.isArray(o.causes) ? o.causes : undefined,
    breadcrumbs: Array.isArray(o.breadcrumbs) ? o.breadcrumbs : undefined,
    related: Array.isArray(o.related) ? o.related : undefined,
  };
}

/**
 * Fallback локальное хранилище (если Level 0 почему-то не поднялся).
 */
class LocalBuf {
  constructor(capacity = 200) {
    this.capacity = Math.max(10, Number(capacity || 200));
    /** @type {UiError[]} */
    this.buf = [];
    /** @type {Set<Function>} */
    this.listeners = new Set();
    this.dropped = 0;
  }
  stats() {
    return { capacity: this.capacity, size: this.buf.length, dropped: this.dropped };
  }
  push(input, overrides = {}) {
    const err = normalizeUiError(input, overrides);
    if (this.buf.length >= this.capacity) {
      this.buf.shift();
      this.dropped += 1;
    }
    this.buf.push(err);
    for (const fn of this.listeners) {
      try {
        fn(err, this.stats());
      } catch {}
    }
    return err;
  }
  subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  snapshot(opts = {}) {
    const limit = Math.max(1, Number(opts.limit || 50));
    return { items: this.buf.slice(-limit), stats: this.stats() };
  }
  clear() {
    this.buf = [];
    this.dropped = 0;
  }
}

/**
 * Адаптер над Level 0: тот же API, но реальные данные в __DBG0__.
 */
export class UiErrorCore {
  constructor(opts = {}) {
    this.capacity = Math.max(10, Number(opts.capacity || 200));
    this._local = new LocalBuf(this.capacity);

    this._unsub = null;
    this._hasL0 = false;

    // если Level0 уже есть — подключаемся сразу
    this._attachLevel0();
  }

  _getL0() {
    return globalThis.window?.__DBG0__ || null;
  }

  _attachLevel0() {
    const l0 = this._getL0();
    const sub = l0 && typeof l0.subscribeErrors === "function";
    if (!l0 || !sub) {
      this._hasL0 = false;
      return;
    }

    if (this._unsub) return;

    this._hasL0 = true;

    // Прокидываем события Level0 -> подписчики Level1
    this._unsub = l0.subscribeErrors((err) => {
      // локально не сохраняем как источник правды; только нотификация
      for (const fn of this._local.listeners) {
        try {
          fn(err, this.stats());
        } catch {}
      }
    });
  }

  stats() {
    const l0 = this._getL0();
    const snap = l0 && typeof l0.snapshot === "function" ? l0.snapshot({ errors: 1 }) : null;
    const size = Number(snap?.stats?.size?.errors || 0);
    const dropped = Number(snap?.stats?.dropped?.errors || 0);
    const cap = Number(snap?.stats?.cap?.errors || this.capacity);
    return { capacity: cap, size, dropped };
  }

  /**
   * push() всегда должен попадать в Level 0 (source of truth).
   */
  push(input, overrides = {}) {
    const l0 = this._getL0();
    if (l0 && typeof l0.pushError === "function") {
      this._attachLevel0();
      const err = normalizeUiError(input, overrides);
      // Важно: pushError принимает (input, overrides), но чтобы не потерять нормализацию — передаём input + overrides.
      // overrides отдаём с ключами контракта (scope/severity/message/ctx/etc).
      try {
        return l0.pushError(input, { ...overrides, scope: err.scope, severity: err.severity, title: err.title, message: err.message, details: err.details, hint: err.hint, ctx: err.ctx, dedupe_key: err.dedupe_key, actions: err.actions, location: err.location, causes: err.causes, breadcrumbs: err.breadcrumbs, related: err.related });
      } catch {
        // если Level0 сломался — fallback
        return this._local.push(input, overrides);
      }
    }

    // fallback (не норма, но не падаем)
    return this._local.push(input, overrides);
  }

  subscribe(fn) {
    this._attachLevel0();
    return this._local.subscribe(fn);
  }

  snapshot(opts = {}) {
    const l0 = this._getL0();
    if (l0 && typeof l0.snapshot === "function") {
      const limit = Math.max(1, Number(opts.limit || 50));
      const snap = l0.snapshot({ errors: limit });
      const items = Array.isArray(snap?.errors) ? snap.errors : [];
      return { items, stats: this.stats() };
    }
    return this._local.snapshot(opts);
  }

  clear() {
    const l0 = this._getL0();
    // Level0 clear пока не специфицирован явно — не додумываем.
    // Здесь чистим только fallback.
    this._local.clear();
    // Если нужно будет очистка Level0 — добавим явный API в Level0 и используем его.
    void l0;
  }
}

/**
 * Singleton (для простого подключения в App/Graph/Run)
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
