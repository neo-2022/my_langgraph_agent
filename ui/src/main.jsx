import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// React Flow styles
import "reactflow/dist/style.css";

import "./index.css";
import "./railLogo.css";
import App from "./App.jsx";

/**
 * Debugger Level 0 (Bootstrap, до React)
 * Требование (см. CHECKLIST 1.0.1 + debugger/README.md 0.1):
 * - стартует до createRoot(...).render(...)
 * - показывает окно отладки даже если App/React не смонтировался
 *
 * Важно: это НЕ "движок". Это минимальный аварийный слой: ловит fatal ошибки и даёт Copy.
 */
function initDebuggerLevel0() {
  // Избегаем двойной инициализации (например HMR).
  if (window.__DBG0__?.__inited) return window.__DBG0__;

  const state = {
    __inited: true,
    opened: false,
    lastError: null,
    events: [],
  };

  const css = `
#dbg0-overlay{position:fixed;inset:0;z-index:2147483647;display:none;background:rgba(0,0,0,.55);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial}
#dbg0-panel{position:absolute;top:24px;left:24px;right:24px;max-height:calc(100vh - 48px);background:#111;color:#eee;border:1px solid rgba(255,255,255,.18);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);overflow:auto}
#dbg0-head{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.12)}
#dbg0-title{font-weight:700;letter-spacing:.2px}
#dbg0-actions{display:flex;gap:8px;align-items:center}
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

  const btnClose = document.createElement("button");
  btnClose.type = "button";
  btnClose.className = "dbg0-btn";
  btnClose.textContent = "Close";

  actions.appendChild(btnCopy);
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
    "Это аварийный bootstrap Debugger: показывается при ошибке до старта React. Полная панель Debugger доступна после старта UI.";

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

  function formatErrorPayload(e) {
    const payload = {
      ts: new Date().toISOString(),
      userAgent: navigator.userAgent,
      href: String(location.href),
      error: e,
    };
    return JSON.stringify(payload, null, 2);
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

  function record(kind, data) {
    state.events.push({ ts: new Date().toISOString(), kind, data });
    if (state.events.length > 200) state.events.shift();
  }

  function showError(kind, errObj) {
    state.lastError = { kind, ...errObj };
    record("fatal", state.lastError);

    const message = String(errObj?.message || "");
    const stack = String(errObj?.stack || "");

    setKV([
      ["kind", kind],
      ["message", message || "(no message)"],
      ["time", new Date().toISOString()],
      ["url", String(location.href)],
    ]);

    pre.textContent = stack || JSON.stringify(errObj, null, 2) || "(no details)";
    open();
  }

  // UI handlers
  btnClose.addEventListener("click", () => close());
  btnCopy.addEventListener("click", async () => {
    const txt = formatErrorPayload(state.lastError || { message: "(no error)" });
    await copyText(txt);
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

  // Error traps (до React)
  window.addEventListener(
    "error",
    (ev) => {
      const err = ev?.error;
      showError("window.error", {
        message: String(err?.message || ev?.message || "Unknown error"),
        stack: String(err?.stack || ""),
        file: String(ev?.filename || ""),
        line: Number(ev?.lineno || 0),
        col: Number(ev?.colno || 0),
      });
    },
    true
  );

  window.addEventListener(
    "unhandledrejection",
    (ev) => {
      const r = ev?.reason;
      showError("unhandledrejection", {
        message: String(r?.message || r || "Unhandled rejection"),
        stack: String(r?.stack || ""),
      });
    },
    true
  );

  const api = {
    ...state,
    open,
    close,
    toggle,
    record,
    showError,
    snapshot() {
      return {
        ts: new Date().toISOString(),
        href: String(location.href),
        userAgent: navigator.userAgent,
        lastError: state.lastError,
        events: state.events.slice(-50),
      };
    },
  };

  window.__DBG0__ = api;
  return api;
}

// MUST be called before React render (Level 0 requirement)
window.__DBG0_ACTIVE__ = true;
initDebuggerLevel0();

// React app start
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

window.__DBG0_ACTIVE__ = false;
