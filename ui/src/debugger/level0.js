import { httpClient } from "../obs/httpClient.js";
import { outbox } from "../obs/outbox.js";

/**
 * Debugger Level 0 (Bootstrap, до React)
 *
 * Требование (см. CHECKLIST 1.0.1 + ui/src/debugger/README.md 0.1):
 * - стартует до createRoot(...).render(...)
 * - показывает окно отладки даже если App/React не смонтировался
 *
 * Важно: Level 0 = источник правды. UI/React (Level 1) только читает/пушит в Level 0.
 *
 * Экспорт:
 * - initDebuggerLevel0(): инициализация и установка window.__DBG0__ (singleton)
 */
export function initDebuggerLevel0() {
  // Избегаем двойной инициализации (например HMR).
  if (window.__DBG0__?.__inited) return window.__DBG0__;

  // ----------------------------
  // 0) Утилиты (без внешних deps)
  // ----------------------------
  function nowIso() {
    return new Date().toISOString();
  }

  function toStr(v) {
    try {
      if (v == null) return "";
      return typeof v === "string" ? v : String(v);
    } catch {
      return "";
    }
  }

  function genId(prefix = "e") {
    try {
      if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch {}
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function ensureTraceId(value) {
    const fromEvent = toStr(value).trim();
    return fromEvent || genId("trace");
  }

  function safeJson(v) {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      try {
        return String(v);
      } catch {
        return "(unserializable)";
      }
    }
  }


  function parseStackLocation(stackText) {
    // Достаём file:line:col из stacktrace (Chrome/Firefox).
    // Это парсинг данных, не "угадайка".
    try {
      const s = String(stackText || "");
      if (!s) return null;
      const lines = s.split(/\r?\n/).map((x) => String(x).trim()).filter(Boolean);

      // Примеры:
      // at fn (http://127.0.0.1:5175/src/App.jsx:123:45)
      // at http://127.0.0.1:5175/src/App.jsx:123:45
      // at /src/App.jsx:123:45
      const re1 = /\(?((?:https?:\/\/|\/).+?):(\d+):(\d+)\)?$/;

      for (const ln of lines) {
        const mm = ln.match(re1);
        if (!mm) continue;

        const file = String(mm[1] || "");
        const line = Number(mm[2] || 0) || 0;
        const col = Number(mm[3] || 0) || 0;

        if (!file || !line) continue;

        return { file, line, col: col || undefined };
      }
      return null;
    } catch {
      return null;
    }
  }

  function extractCauses(input, maxDepth = 6) {
    // Цепочка причин из Error.cause / AggregateError.errors.
    // Только по структуре данных, без правил по строкам.
    const out = [];
    const seen = new Set();

    function packOne(e, note) {
      if (!e) return;
      if (seen.has(e)) return;
      seen.add(e);

      const obj = e && typeof e === "object" ? e : { value: e };
      const msg = toStr(obj.message) || toStr(obj.name) || toStr(obj) || "(no message)";
      const st = toStr(obj.stack);
      out.push({ message: msg, stack: st || undefined, note: note || undefined });
    }

    function walk(e, depth) {
      if (!e || depth > maxDepth) return;

      // AggregateError
      try {
        if (typeof AggregateError !== "undefined" && e instanceof AggregateError) {
          packOne(e, "AggregateError");
          const errs = Array.isArray(e.errors) ? e.errors : [];
          for (const sub of errs.slice(0, 10)) walk(sub, depth + 1);
          return;
        }
      } catch {}

      packOne(e);

      // cause
      try {
        const c = e && typeof e === "object" ? e.cause : undefined;
        if (c) walk(c, depth + 1);
      } catch {}
    }

    walk(input, 0);
    return out.length ? out : null;
  }

// ----------------------------
  // 1) Хранилище (ring buffers)
  // ----------------------------
  const state = {
    __inited: true,
    opened: false,

    // Последняя фатальная ошибка (для overlay)
    lastFatal: null,

    // Каналы (source of truth)
    // capacity можно расширять позже из конфига/настроек (без хардкода логики, только лимиты)
    cap: {
      errors: 200,
      events: 200,
      network: 200,
      snapshots: 200,
      breadcrumbs: 80,
    },

    // данные
    errors: [], // нормализованные UiError (v1)
    events: [], // DebugEvent (пока простой конверт)
    network: [], // network events
    snapshots: [], // graph/run snapshots

    // мета
    dropped: { errors: 0, events: 0, network: 0, snapshots: 0 },

    // dedupe/throttle (анти-спам)
    // dedupe_key -> {count,last_ts,first_ts,last_id}
    dedupe: new Map(),
    // throttle_key -> last_ts_ms
    throttle: new Map(),

    // listeners
    listeners: {
      error: new Set(),
      event: new Set(),
      network: new Set(),
      snapshot: new Set(),
    },
  };

  function ringPush(arr, capKey, droppedKey, item) {
    const cap = Math.max(10, Number(state.cap[capKey] || 200));
    if (arr.length >= cap) {
      arr.shift();
      state.dropped[droppedKey] = Number(state.dropped[droppedKey] || 0) + 1;
    }
    arr.push(item);
  }

  // ----------------------------
  // 2) Нормализация UiError (по CHECKLIST 1.0.3 + debugger/README 5)
  // ----------------------------
  function normalizeUiError(input, overrides = {}) {
    const o = overrides || {};
    const ts = toStr(o.ts) || nowIso();
    const id = toStr(o.id) || genId("err");

    // scope: run|api|graph|models|assistant|tools|ui_proxy|ui
    // Важно: не делаем "маппинг" источников, просто принимаем scope как есть.
    const scope = toStr(o.scope) || toStr(o.source) || "ui";

    // severity: info|warn|error|fatal
    const severity = toStr(o.severity) || "error";

    // title/message/hint — RU тексты
    const title = toStr(o.title) || "";
    let message = toStr(o.message);
    let stack = toStr(o.stack);

    if (!message) {
      if (input && typeof input === "object") {
        message =
          toStr(input.message) ||
          toStr(input.reason) ||
          toStr(input.name) ||
          toStr(input) ||
          "";
      } else {
        message = toStr(input);
      }
    }
    if (!stack && input && typeof input === "object") stack = toStr(input.stack);

    // details: raw stack/http/body/json
    const details =
      o.details !== undefined
        ? o.details
        : stack
        ? { stack }
        : input && typeof input === "object"
        ? input
        : { value: input };

    // ctx: run_id, assistant_id, model, node_id, span_id, endpoint, tab, etc.
    const ctx =
      o.ctx && typeof o.ctx === "object"
        ? o.ctx
        : o.context && typeof o.context === "object"
        ? o.context
        : undefined;

    // location: {file,line,col,function?} — пока берём только то, что явно дали
    const location =
        o.location && typeof o.location === "object"
          ? o.location
          : stack
          ? parseStackLocation(stack)
          : undefined;

    // causes / breadcrumbs / related — пока принимаем если передали (без угадайки)
    const causes = Array.isArray(o.causes) ? o.causes : extractCauses(input);
    const breadcrumbs = Array.isArray(o.breadcrumbs) ? o.breadcrumbs : undefined;
    const related = Array.isArray(o.related) ? o.related : undefined;

    // actions: copy/retry/open/restart/clear/reload/jump
    const actions = Array.isArray(o.actions) ? o.actions : undefined;

    // dedupe_key — если не передали, строим детерминированно без "угадайки"
    // Важно: это НЕ "маппинг", а анти-спам ключ по данным самой ошибки.
    const dedupe_key =
      toStr(o.dedupe_key) ||
      `${scope}|${toStr(o.code)}|${toStr(message).slice(0, 160)}|${toStr(location?.file)}:${toStr(location?.line)}:${toStr(
        location?.col
      )}`;

    return {
      id,
      ts,
      scope,
      severity,
      title: title || "",
      message: message || "(no message)",
      details,
      hint: toStr(o.hint) || "",
      ctx,
      dedupe_key,
      actions,
      location,
      causes,
      breadcrumbs,
      related,
    };
  }

  // ----------------------------
  // 3) Dedupe/Throttle (debugger/README 6)
  // ----------------------------
  function shouldThrottle(err) {
    // throttle частых одинаковых ошибок — не чаще 1/сек (настраиваемо позже)
    // fatal не троттлим
    const sev = String(err?.severity || "");
    if (sev === "fatal") return false;

    const key = String(err?.dedupe_key || "");
    if (!key) return false;

    const now = Date.now();
    const last = Number(state.throttle.get(key) || 0);
    const windowMs = 1000;

    if (now - last < windowMs) return true;
    state.throttle.set(key, now);
    return false;
  }

  function applyDedupe(err) {
    const key = String(err?.dedupe_key || "");
    if (!key) return { grouped: false };

    const rec = state.dedupe.get(key);
    if (!rec) {
      state.dedupe.set(key, {
        count: 1,
        first_ts: err.ts,
        last_ts: err.ts,
        last_id: err.id,
      });
      return { grouped: false };
    }

    rec.count += 1;
    rec.last_ts = err.ts;
    rec.last_id = err.id;
    state.dedupe.set(key, rec);
    return {
      grouped: true,
      count: rec.count,
      first_ts: rec.first_ts,
      last_ts: rec.last_ts,
    };
  }

  // ----------------------------
  // 4) Публичное API Level 0
  // ----------------------------
  function notify(kind, payload) {
    const set = state.listeners[kind];
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch {
        // Level 0 не должен падать из-за слушателей
      }
    }
  }

  function pushError(input, overrides = {}) {
    const err = normalizeUiError(input, overrides);

    // breadcrumbs (если не передали) — берём последние события окружения из state.events
    if (!err.breadcrumbs) {
      const crumbs = state.events.slice(
        -Math.max(1, Number(state.cap.breadcrumbs || 80))
      );
      err.breadcrumbs = crumbs;
    }

    // throttle
    if (shouldThrottle(err)) {
      // всё равно учитываем dedupe-счётчик, чтобы было видно масштаб спама
      applyDedupe(err);
      return err;
    }

    // dedupe: храним запись, но счётчик ведём в метаданных
    const d = applyDedupe(err);
    if (d.grouped) {
      err.dedupe = d;
    }

    ringPush(state.errors, "errors", "errors", err);

    // lastFatal для overlay
    if (String(err.severity) === "fatal" || String(err.severity) === "error") {
      state.lastFatal = err;
    }

    notify("error", err);
    return err;
  }

  function subscribeErrors(fn) {
    if (typeof fn !== "function") return () => {};
    state.listeners.error.add(fn);
    return () => state.listeners.error.delete(fn);
  }

function debugEventToRaw(ev) {
    const payload = ev.payload && typeof ev.payload === "object" ? { ...ev.payload } : {};
    const ctx = ev.ctx && typeof ev.ctx === "object" ? { ...ev.ctx } : {};
    const links = Array.isArray(ev.links) ? ev.links.filter(Boolean) : undefined;
    const trace_id = ensureTraceId(ev.trace_id);
    const span_id = toStr(ev.span_id);
    const event_id = toStr(ev.event_id) || genId("ev");
    const debug_ref = ev.debug_ref || (span_id ? { event_id, span_id } : undefined);
    return {
      schema_version: "REGART.Art.RawEvent.v1",
      event_id,
      kind: toStr(ev.name) || "ui.event",
      scope: toStr(ev.origin || ev.ui?.tab || "ui"),
      severity: ["debug", "info", "warn", "error", "fatal"].includes(toStr(ev.level)) ? toStr(ev.level) : "info",
      message: toStr(ev.message) || toStr(ev.name),
      payload: { ...payload, ui: ev.ui, ctx },
      context: {
        trace_id,
        span_id: toStr(ev.span_id),
        run_id: toStr(ev.run_id),
        node_id: toStr(ev.node_id),
        parent_span_id: toStr(ev.parent_span_id),
      },
      links,
      debug_ref,
    };
  }

  function pushToOutbox(ev) {
    try {
      outbox.enqueue(debugEventToRaw(ev)).catch(() => {});
    } catch {}
  }

  function pushEvent(ev) {
    const e = ev && typeof ev === "object" ? ev : { name: "ui.event", payload: ev };
    const trace_id = ensureTraceId(e.trace_id);
    const out = {
      schema_version: "debug_event@1",
      event_id: toStr(e.event_id) || genId("ev"),
      ts: toStr(e.ts) || nowIso(),
      timestamp: toStr(e.ts) || nowIso(),
      level: toStr(e.level) || "info",
      name: toStr(e.name) || "ui.event",
      origin: toStr(e.origin) || "frontend",
      trace_id,
      span_id: toStr(e.span_id) || undefined,
      parent_span_id: toStr(e.parent_span_id) || undefined,
      run_id: toStr(e.run_id) || undefined,
      assistant_id: toStr(e.assistant_id) || undefined,
      node_id: toStr(e.node_id) || undefined,
      attrs: e.attrs && typeof e.attrs === "object" ? e.attrs : undefined,
      payload:
        e.payload && typeof e.payload === "object"
          ? e.payload
          : e.payload !== undefined
          ? { value: e.payload }
          : undefined,
      links: e.links && typeof e.links === "object" ? e.links : undefined,
      ui: e.ui && typeof e.ui === "object" ? e.ui : undefined,
      type: toStr(e.type || e.kind || e.name),
      status: toStr(e.status || e.state || undefined) || undefined,
      duration_ms:
        Number.isFinite(Number(e.duration_ms ?? e.duration ?? e.run_duration))
          ? Number(e.duration_ms ?? e.duration ?? e.run_duration)
          : undefined,
      metadata: e.metadata && typeof e.metadata === "object" ? { ...e.metadata } : undefined,
    };

    ringPush(state.events, "events", "events", out);
    pushToOutbox(out);
    notify("event", out);
    return out;
  }

  function subscribeEvents(fn) {
    if (typeof fn !== "function") return () => {};
    state.listeners.event.add(fn);
    return () => state.listeners.event.delete(fn);
  }

  function pushNetwork(rec) {
    const r = rec && typeof rec === "object" ? rec : { value: rec };
    const out = {
      ts: toStr(r.ts) || nowIso(),
      method: toStr(r.method) || "",
      url: toStr(r.url) || "",
      status: Number.isFinite(Number(r.status)) ? Number(r.status) : undefined,
      duration_ms: Number.isFinite(Number(r.duration_ms))
        ? Number(r.duration_ms)
        : undefined,
      ok: r.ok !== undefined ? !!r.ok : undefined,
      error: r.error !== undefined ? r.error : undefined,
      request: r.request !== undefined ? r.request : undefined,
      response: r.response !== undefined ? r.response : undefined,
      ctx: r.ctx && typeof r.ctx === "object" ? r.ctx : undefined,
    };
    ringPush(state.network, "network", "network", out);
    notify("network", out);
    return out;
  }

  function subscribeNetwork(fn) {
    if (typeof fn !== "function") return () => {};
    state.listeners.network.add(fn);
    return () => state.listeners.network.delete(fn);
  }

  function pushSnapshot(rec) {
    const r = rec && typeof rec === "object" ? rec : { value: rec };
    const out = {
      ts: toStr(r.ts) || nowIso(),
      channel: toStr(r.channel) || "unknown",
      data: r.data !== undefined ? r.data : r,
    };
    ringPush(state.snapshots, "snapshots", "snapshots", out);
    notify("snapshot", out);
    return out;
  }

  function subscribeSnapshots(fn) {
    if (typeof fn !== "function") return () => {};
    state.listeners.snapshot.add(fn);
    return () => state.listeners.snapshot.delete(fn);
  }

  function snapshot(opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};
    const limitErrors = Math.max(1, Number(o.errors || 50));
    const limitEvents = Math.max(1, Number(o.events || 50));
    const limitNet = Math.max(1, Number(o.network || 50));
    const limitSnaps = Math.max(1, Number(o.snapshots || 50));

    return {
      ts: nowIso(),
      href: String(location.href),
      userAgent: navigator.userAgent,

      stats: {
        cap: { ...state.cap },
        size: {
          errors: state.errors.length,
          events: state.events.length,
          network: state.network.length,
          snapshots: state.snapshots.length,
        },
        dropped: { ...state.dropped },
        dedupe_keys: state.dedupe.size,
      },

      lastError: state.lastFatal || null,
      errors: state.errors.slice(-limitErrors),
      events: state.events.slice(-limitEvents),
      network: state.network.slice(-limitNet),
      snapshots: state.snapshots.slice(-limitSnaps),
    };
  }

  // ----------------------------
  // 5) Fallback overlay (без React)
  // ----------------------------
  const css = `
#dbg0-overlay{position:fixed;inset:0;z-index:2147483647;display:none;background:rgba(0,0,0,.55);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial}
#dbg0-panel{position:absolute;top:24px;left:24px;right:24px;max-height:calc(100vh - 48px);background:#111;color:#eee;border:1px solid rgba(255,255,255,.18);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);overflow:auto}
#dbg0-head{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.12)}
#dbg0-title{font-weight:700;letter-spacing:.2px}
#dbg0-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dbg0-btn{appearance:none;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#eee;border-radius:10px;padding:7px 10px;cursor:pointer;font-size:13px}
.dbg0-btn:hover{background:rgba(255,255,255,.12)}
  #dbg0-tip{position:fixed;z-index:2147483647;display:none;padding:6px 10px;border-radius:10px;font-size:12px;line-height:1.25;color:rgba(255,255,255,0.92);background:rgba(0,0,0,0.82);border:1px solid rgba(255,255,255,0.14);box-shadow:0 10px 30px rgba(0,0,0,0.35);max-width:320px;white-space:pre-line;pointer-events:none}
#dbg0-body{padding:12px 14px}
#dbg0-kv{display:grid;grid-template-columns:140px 1fr;gap:6px 10px;font-size:13px;margin-bottom:12px}
#dbg0-pre{white-space:pre-wrap;word-break:break-word;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px;font-size:12px;line-height:1.35}
  #dbg0-errors{margin-top:12px;display:grid;gap:8px}
  .dbg0-err{border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(255,255,255,.04);padding:10px}
  .dbg0-err-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .dbg0-pill{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:12px;opacity:.85}
  .dbg0-err-msg{margin-top:6px;font-weight:700}
  .dbg0-err-where{margin-top:4px;font-size:12px;opacity:.9}
  .dbg0-err-why{margin-top:4px;font-size:12px;opacity:.9}
  .dbg0-copy-mini{appearance:none;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#eee;border-radius:10px;padding:5px 8px;cursor:pointer;font-size:12px;margin-left:auto}
  .dbg0-copy-mini:hover{background:rgba(255,255,255,.12)}
#dbg0-note{opacity:.85;font-size:12px;margin-top:10px}
`;

  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-dbg0", "1");
  styleEl.textContent = css;

  const overlay = document.createElement("div");
  overlay.id = "dbg0-overlay";

  const panel = document.createElement("div");
  panel.id = "dbg0-panel";

  const head = document.createElement("div");
  head.id = "dbg0-head";

  const title = document.createElement("div");
  title.id = "dbg0-title";
  title.textContent = "Debugger (Level 0)";

  const actions = document.createElement("div");
  actions.id = "dbg0-actions";

  const btnCopy = document.createElement("button");
  btnCopy.type = "button";
  btnCopy.className = "dbg0-btn";
  btnCopy.textContent = "Copy details";
  btnCopy.setAttribute("data-tip", "Скопировать детали последней ошибки\n(сообщение и stacktrace).");

  const btnCopyBundle = document.createElement("button");
  btnCopyBundle.type = "button";
  btnCopyBundle.className = "dbg0-btn";
  btnCopyBundle.textContent = "Copy bundle";
  btnCopyBundle.setAttribute("data-tip", "Скопировать Debug Bundle\n(ошибки/события/сеть/снапшоты).");

  const btnClose = document.createElement("button");
  btnClose.type = "button";
  btnClose.className = "dbg0-btn";
  btnClose.textContent = "Close";
  btnClose.setAttribute("data-tip", "Закрыть окно отладчика (Level 0).");

  actions.appendChild(btnCopy);
  actions.appendChild(btnCopyBundle);
  actions.appendChild(btnClose);

  // Tooltip (без React): свои подсказки на русском (без title)
  const tipEl = document.createElement("div");
  tipEl.id = "dbg0-tip";

  function ensureTipMounted() {
    if (!document.body.contains(tipEl)) document.body.appendChild(tipEl);
  }

  function showTipFor(btn) {
    try {
      const txt = String(btn?.getAttribute("data-tip") || "");
      if (!txt) return;

      ensureMounted();
      ensureTipMounted();

      tipEl.textContent = txt;

      const r = btn.getBoundingClientRect();
      const margin = 10;

      // сначала показываем, потом измеряем
      tipEl.style.display = "block";
      const tr = tipEl.getBoundingClientRect();

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const spaceBelow = vh - r.bottom - margin;
      const spaceAbove = r.top - margin;

      const wantUp = spaceAbove >= tr.height + margin && spaceAbove > spaceBelow;
      let top = wantUp ? r.top - tr.height - margin : r.bottom + margin;

      // clamp Y
      top = Math.max(margin, Math.min(vh - tr.height - margin, top));

      // по центру кнопки, clamp X
      let left = r.left + r.width / 2;
      const halfW = tr.width / 2;
      left = Math.max(margin + halfW, Math.min(vw - margin - halfW, left));

      tipEl.style.left = left + "px";
      tipEl.style.top = top + "px";
      tipEl.style.transform = "translateX(-50%)";
    } catch {}
  }

  function hideTip() {
    try { tipEl.style.display = "none"; } catch {}
  }

  function bindTip(btn) {
    if (!btn) return;
    btn.addEventListener("mouseenter", () => showTipFor(btn));
    btn.addEventListener("mouseleave", () => hideTip());
    btn.addEventListener("focus", () => showTipFor(btn));
    btn.addEventListener("blur", () => hideTip());
  }

  head.appendChild(title);
  head.appendChild(actions);

  const body = document.createElement("div");
  body.id = "dbg0-body";

  const kv = document.createElement("div");
  kv.id = "dbg0-kv";

  const pre = document.createElement("div");
  pre.id = "dbg0-pre";

  const note = document.createElement("div");
  note.id = "dbg0-note";
  note.textContent =
    "Это Debugger Level 0 (до React). Он должен показывать ошибки даже если UI упал. Level 1 (React) — только отображение.";

  body.appendChild(kv);
  body.appendChild(pre);
  const errorsBox = document.createElement("div");
  errorsBox.id = "dbg0-errors";
  body.appendChild(errorsBox);
  body.appendChild(note);

  panel.appendChild(head);
  panel.appendChild(body);
  overlay.appendChild(panel);

  function ensureMounted() {
    if (!document.head.querySelector("style[data-dbg0='1']")) {
      document.head.appendChild(styleEl);
    }
    if (!document.body.contains(overlay)) {
      document.body.appendChild(overlay);
    }
  }

  function setKV(rows) {
    kv.textContent = "";
    for (const [k, v] of rows) {
      const kEl = document.createElement("div");
      kEl.style.opacity = "0.85";
      kEl.textContent = k;

      const vEl = document.createElement("div");
      vEl.textContent = v;

      kv.appendChild(kEl);
      kv.appendChild(vEl);
    }

    function pick(obj, key, fallback = "") {
      try {
        return obj && typeof obj === "object" && obj[key] !== undefined ? obj[key] : fallback;
      } catch {
        return fallback;
      }
    }

    function toActionList(err) {
      const d = err && typeof err === "object" ? err.details : null;
      const acts0 = d && typeof d === "object" ? d.actions : null;
      return Array.isArray(acts0) ? acts0 : [];
    }

    function actionLabelRu(a) {
      const typ = String(pick(a, "type", "") || "").trim();
      const ep = String(pick(a, "endpoint", "") || "").trim();

      // Только текст/лейбл (логика не завязана на это)
      if (typ === "restart_langgraph" || ep === "/ui/restart-langgraph") return "Перезапустить LangGraph";
      if (typ === "langgraph_start" || ep === "/ui/langgraph/start") return "Запустить LangGraph";
      if (typ === "langgraph_stop" || ep === "/ui/langgraph/stop") return "Остановить LangGraph";
      if (typ === "reload") return "Перезагрузить страницу";
      if (typ) return typ;
      return ep || "action";
    }

    async function runEndpoint(endpoint, method = "POST") {
      const ep = String(endpoint || "");
      if (!ep) return { ok: false, error: "empty endpoint" };

      try {
        const resp = await httpClient.request(ep, { method, parseAs: "raw" });
        const txt = await resp.text().catch(() => "");
        let js = null;
        try {
          js = txt ? JSON.parse(txt) : null;
        } catch {}
        if (!resp.ok) return { ok: false, status: resp.status, text: txt, json: js };
        return { ok: true, status: resp.status, text: txt, json: js };
      } catch (e) {
        const resp = e?.response;
        const txt = typeof e?.responseText === "string" ? e.responseText : "";
        let json = null;
        try {
          json = txt ? JSON.parse(txt) : null;
        } catch {}
        if (resp) {
          return { ok: false, status: resp.status, text: txt, json };
        }
        return { ok: false, error: String(e?.message || e) };
      }
    }

    function clearActs() {
      try {
        acts.textContent = "";
      } catch {}
    }

    function addHumanRow(k, v) {
      const row = document.createElement("div");
      row.className = "dbg0-human-row";

      const kEl = document.createElement("span");
      kEl.className = "dbg0-human-k";
      kEl.textContent = k;

      const vEl = document.createElement("span");
      vEl.textContent = v;

      row.appendChild(kEl);
      row.appendChild(vEl);
      human.insertBefore(row, acts);
    }

    function renderHumanError(err) {
      // чистим строки
      try {
        const rows = human.querySelectorAll(".dbg0-human-row");
        rows.forEach((n) => n.remove());
      } catch {}

      clearActs();

      const sev = toStr(err?.severity) || "error";
      const scope = toStr(err?.scope) || "ui";
      const msg = toStr(err?.message) || "(no message)";
      const hint = toStr(err?.hint) || "";

      const loc = err && typeof err === "object" ? err.location : null;
      const where =
        loc && typeof loc === "object" && loc.file
          ? `${toStr(loc.file)}:${toStr(loc.line)}:${toStr(loc.col)}`
          : "";

      const d = err && typeof err === "object" ? err.details : null;
      const service = toStr(pick(d, "service", "")) || toStr(pick(err?.ctx, "service", ""));
      const et = toStr(pick(d, "error_type", "")) || toStr(pick(err?.ctx, "error_type", ""));
      const upstream =
        toStr(pick(d, "upstream_base_url", "")) || toStr(pick(err?.ctx, "upstream_base_url", ""));
      const upstreamUrl =
        toStr(pick(d, "upstream_url", "")) || toStr(pick(err?.ctx, "upstream_url", ""));

      humanTitle.textContent = msg;

      addHumanRow("Источник:", `${scope} / ${sev}${service ? " / " + service : ""}`);
      if (where) addHumanRow("Где:", where);
      if (upstream) addHumanRow("Сервис:", upstream);
      if (upstreamUrl) addHumanRow("URL:", upstreamUrl);
      if (et) addHumanRow("Тип:", et);

      const why = toStr(pick(d, "error", "")) || "";
      if (why) addHumanRow("Почему:", why);

      if (hint) addHumanRow("Что делать:", hint);

      const action_list = toActionList(err);
      if (action_list.length) {
        for (const a of action_list) {
          const ep = String(pick(a, "endpoint", "") || "").trim();
          const typ = String(pick(a, "type", "") || "").trim();
          const label = actionLabelRu(a);

          const b = document.createElement("button");
          b.type = "button";
          b.className = "dbg0-actbtn";
          b.textContent = label;

          // tooltip
          const tip = ep
            ? `Действие: ${label}
Вызов: ${ep}`
            : `Действие: ${label}`;
          b.setAttribute("data-tip", tip);
          bindTip(b);

          b.addEventListener("click", async () => {
            if (typ === "reload") {
              try { location.reload(); } catch {}
              return;
            }
            if (!ep) return;

            const res = await runEndpoint(ep, "POST");
            // запишем событие в Level0 (видно в bundle)
            try {
              pushEvent({
                level: res.ok ? "info" : "error",
                name: "ui.action",
                payload: { action: typ || label, endpoint: ep, result: res },
              });
            } catch {}
            // обновим отображение snapshot/kv/pre
            try {
              renderHumanError(state.lastFatal || err);
            } catch {}
          });

          acts.appendChild(b);
        }
      }
    }
  }

  async function copyText(txt) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(txt);
        return true;
      }
    } catch (_) {}

    try {
      const ta = document.createElement("textarea");
      ta.value = txt;
      ta.setAttribute("readonly", "true");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch (_) {
      return false;
    }
  }

  function open() {
    ensureMounted();
    try { renderErrorsList(); } catch {}
    overlay.style.display = "block";
    state.opened = true;
  }

  function close() {
    overlay.style.display = "none";
    state.opened = false;
  }

  function toggle() {
    if (state.opened) close();
    else open();
  }


  function renderErrorsList() {
    try {
      if (!errorsBox) return;
      errorsBox.textContent = "";

      const items = Array.isArray(state.errors) ? state.errors.slice(-10).reverse() : [];
      if (!items.length) {
        const empty = document.createElement("div");
        empty.style.opacity = "0.85";
        empty.style.fontSize = "12px";
        empty.textContent = "Ошибок пока нет.";
        errorsBox.appendChild(empty);
        return;
      }

      const head = document.createElement("div");
      head.style.fontWeight = "700";
      head.style.marginTop = "2px";
      head.textContent = "Последние ошибки";
      errorsBox.appendChild(head);

      for (const e of items) {
        const wrap = document.createElement("div");
        wrap.className = "dbg0-err";

        const h = document.createElement("div");
        h.className = "dbg0-err-head";

        const pill1 = document.createElement("span");
        pill1.className = "dbg0-pill";
        pill1.textContent = String(e?.scope || "ui");
        const pill2 = document.createElement("span");
        pill2.className = "dbg0-pill";
        pill2.textContent = String(e?.severity || "error");

        const pill3 = document.createElement("span");
        pill3.className = "dbg0-pill";
        pill3.textContent = String(e?.ts || "");

        const cnt = Number(e?.dedupe?.count || 0);
        const pill4 = document.createElement("span");
        pill4.className = "dbg0-pill";
        pill4.textContent = cnt > 1 ? ("×" + String(cnt)) : "";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dbg0-copy-mini";
        btn.textContent = "Copy";
        btn.setAttribute("data-tip", "Скопировать эту ошибку (JSON) в буфер обмена.");
        bindTip(btn);
        btn.addEventListener("click", async () => {
          try { await copyText(safeJson(e || {})); } catch {}
        });

        h.appendChild(pill1);
        h.appendChild(pill2);
        h.appendChild(pill3);
        if (pill4.textContent) h.appendChild(pill4);
        h.appendChild(btn);

        const msg = document.createElement("div");
        msg.className = "dbg0-err-msg";
        msg.textContent = String(e?.message || e?.title || "—");

        const loc = e?.location || {};
        const file = String(loc?.file || "");
        const line = loc?.line ? String(loc.line) : "";
        const col = loc?.col ? String(loc.col) : "";
        const where = file ? (file + (line ? ":" + line : "") + (col ? ":" + col : "")) : "—";

        const w = document.createElement("div");
        w.className = "dbg0-err-where";
        w.innerHTML = "<b>Где:</b> <span class='dbg0-pill'></span>";
        w.querySelector("span").textContent = where;

        const causes = Array.isArray(e?.causes) ? e.causes : [];
        const why = causes.length ? String(causes[0]?.message || "—") : "—";
        const c = document.createElement("div");
        c.className = "dbg0-err-why";
        c.innerHTML = "<b>Почему:</b> <span></span>";
        c.querySelector("span").textContent = why;

        wrap.appendChild(h);
        wrap.appendChild(msg);
        wrap.appendChild(w);
        wrap.appendChild(c);

        errorsBox.appendChild(wrap);
      }
    } catch {}
  }

function showOverlayForError(err) {
    const sev = toStr(err?.severity);
    const sc = toStr(err?.scope);

    setKV([
      ["severity", sev || "error"],
      ["scope", sc || "ui"],
      ["time", toStr(err?.ts) || nowIso()],
      ["url", String(location.href)],
    ]);

    pre.textContent = safeJson(err);
      try { renderErrorsList(); } catch {}
      open();
  }

  // UI handlers
  btnClose.addEventListener("click", () => close());
  bindTip(btnCopy);
  bindTip(btnCopyBundle);
  bindTip(btnClose);

  btnCopy.addEventListener("click", async () => {
    const txt = safeJson(state.lastFatal || { empty: true });
    await copyText(txt);
  });

  btnCopyBundle.addEventListener("click", async () => {
    const snap = snapshot({ errors: 50, events: 50, network: 50, snapshots: 50 });
    await copyText(safeJson({ kind: "debug_bundle@1", ...snap }));
  });

  // Hotkey Level 0: Alt+Ctrl+E (toggle overlay)
  window.addEventListener(
    "keydown",
    (e) => {
      const key = String(e?.key || "").toLowerCase();
      if (!window.__DBG0_ACTIVE__) return;
      if (e?.altKey && e?.ctrlKey && key === "e") {
        e.preventDefault();
        toggle();
      }
    },
    true
  );

  // ----------------------------
  // 6) Error traps (до React) — и навсегда (Level0 всегда активен)
  // ----------------------------
    // ----------------------------
    // DBG0_CONSOLE_HOOK: console.warn/error -> UiError (чтобы ловить dev-warn библиотек и сообщения консоли)
    // ----------------------------
    (function DBG0_CONSOLE_HOOK() {
      try {
        const origWarn = console.warn ? console.warn.bind(console) : null;
        const origError = console.error ? console.error.bind(console) : null;

        // защита от рекурсии (если внутри pushError кто-то пишет в console)
        let inHook = false;

        function fmt(args) {
          try {
            return (args || [])
              .map((a) => {
                if (a == null) return "";
                if (typeof a === "string") return a;
                if (a instanceof Error) return a.message || String(a);
                try {
                  return JSON.stringify(a);
                } catch {
                  return String(a);
                }
              })
              .filter(Boolean)
              .join(" ");
          } catch {
            return "";
          }
        }

        function stackFromHere(tag) {
          try {
            throw new Error(tag || "console");
          } catch (e) {
            return toStr(e && typeof e === "object" ? e.stack : "");
          }
        }

        if (origWarn) {
          console.warn = (...args) => {
            try {
              if (!inHook) {
                inHook = true;
                const msg = fmt(args) || "console.warn";
                const st = stackFromHere("console.warn");
                pushError(new Error(msg), {
                  scope: "ui",
                  severity: "warn",
                  title: "",
                  message: msg,
                  details: { kind: "console.warn", args, stack: st },
                  ctx: { where: "console.warn" },
                  actions: ["copy", "open"],
                });
              }
            } catch {} finally {
              inHook = false
            }
            try { origWarn(...args); } catch {}
          };
        }

        if (origError) {
          console.error = (...args) => {
            try {
              if (!inHook) {
                inHook = true;
                const msg = fmt(args) || "console.error";
                const st = stackFromHere("console.error");
                pushError(new Error(msg), {
                  scope: "ui",
                  severity: "error",
                  title: "",
                  message: msg,
                  details: { kind: "console.error", args, stack: st },
                  ctx: { where: "console.error" },
                  actions: ["copy", "open"],
                });
              }
            } catch {} finally {
              inHook = false
            }
            try { origError(...args); } catch {}
          };
        }
      } catch {
        // ignore
      }
    })();


  window.addEventListener(
    "error",
    (ev) => {
      const err = ev?.error;
      const msg = String(err?.message || ev?.message || "Unknown error");

      // Browser noise: не считаем фатальной ошибкой старта UI.
      if (msg === "ResizeObserver loop completed with undelivered notifications.") {
        pushEvent({
          level: "warn",
          name: "ui.warn",
          payload: { kind: "window.error", message: msg },
        });
        return;
      }

      const uiErr = pushError(err || ev, {
        scope: "ui",
        severity: "fatal",
        title: "",
        message: msg,
        location: {
          file: toStr(ev?.filename),
          line: Number(ev?.lineno || 0) || undefined,
          col: Number(ev?.colno || 0) || undefined,
        },
        ctx: { where: "window.error" },
        actions: ["copy", "reload", "open"],
      });

      showOverlayForError(uiErr);
    },
    true
  );

  window.addEventListener(
    "unhandledrejection",
    (ev) => {
      const r = ev?.reason;
      const msg = String(r?.message || r || "Unhandled rejection");

      const uiErr = pushError(r || ev, {
        scope: "ui",
        severity: "fatal",
        title: "",
        message: msg,
        details: r && typeof r === "object" ? r : { reason: r },
        ctx: { where: "unhandledrejection" },
        actions: ["copy", "reload", "open"],
      });

      showOverlayForError(uiErr);
    },
    true
  );

  // ----------------------------
  // 7) Экспорт API Level 0
  // ----------------------------

  function clearErrors() {
    state.errors = [];
    state.dropped.errors = 0;
    state.lastFatal = null;
    state.dedupe = new Map();
    state.throttle = new Map();
  }

  function clearAll() {
    clearErrors();
    state.events = [];
    state.network = [];
    state.snapshots = [];
    state.dropped.events = 0;
    state.dropped.network = 0;
    state.dropped.snapshots = 0;
  }

  const api = {
    __inited: true,

    // overlay controls
    open,
    close,
    toggle,

    // source-of-truth APIs
    pushError,
    subscribeErrors,
    clearErrors,
    clearAll,

    pushEvent,
    subscribeEvents,

    pushNetwork,
    subscribeNetwork,

    pushSnapshot,
    subscribeSnapshots,

    snapshot,
  };

  window.__DBG0__ = api;
  return api;
}
