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
      o.location && typeof o.location === "object" ? o.location : undefined;

    // causes / breadcrumbs / related — пока принимаем если передали (без угадайки)
    const causes = Array.isArray(o.causes) ? o.causes : undefined;
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

  function pushEvent(ev) {
    const e = ev && typeof ev === "object" ? ev : { name: "ui.event", payload: ev };
    const out = {
      schema_version: "debug_event@1",
      event_id: toStr(e.event_id) || genId("ev"),
      ts: toStr(e.ts) || nowIso(),
      level: toStr(e.level) || "info",
      name: toStr(e.name) || "ui.event",
      origin: toStr(e.origin) || "frontend",
      trace_id: toStr(e.trace_id) || undefined,
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
    };

    ringPush(state.events, "events", "events", out);
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
#dbg0-body{padding:12px 14px}
#dbg0-kv{display:grid;grid-template-columns:140px 1fr;gap:6px 10px;font-size:13px;margin-bottom:12px}
#dbg0-pre{white-space:pre-wrap;word-break:break-word;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px;font-size:12px;line-height:1.35}
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

  const btnCopyBundle = document.createElement("button");
  btnCopyBundle.type = "button";
  btnCopyBundle.className = "dbg0-btn";
  btnCopyBundle.textContent = "Copy bundle";

  const btnClose = document.createElement("button");
  btnClose.type = "button";
  btnClose.className = "dbg0-btn";
  btnClose.textContent = "Close";

  actions.appendChild(btnCopy);
  actions.appendChild(btnCopyBundle);
  actions.appendChild(btnClose);

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
    open();
  }

  // UI handlers
  btnClose.addEventListener("click", () => close());

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
  const api = {
    __inited: true,

    // overlay controls
    open,
    close,
    toggle,

    // source-of-truth APIs
    pushError,
    subscribeErrors,

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
