import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import "./App.css";
import "reactflow/dist/style.css";
import GraphView from "./GraphView.jsx";
import SplitView from "./SplitView.jsx";
import { getUiErrorCore } from "./debugger/core.js";
import { fetchClientInfo } from "./obs/clientInfo.js";
import { httpClient } from "./obs/httpClient.js";


  // ----------------------------
  // DBG0 шлюз: любое UI-событие/ошибка -> Level 0 (source of truth)
  // ----------------------------
  function _dbgStr(v) {
    try {
      if (v == null) return "";
      return typeof v === "string" ? v : String(v);
    } catch {
      return "";
    }
  }

  function _dbgPick(obj, key) {
    try {
      return obj && typeof obj === "object" ? obj[key] : undefined;
    } catch {
      return undefined;
    }
  }

  function _dbgMsgFrom(e) {
    try {
      const dbg = e && typeof e === "object" ? e.__dbg : null;
      const hint = dbg && typeof dbg === "object" ? _dbgStr(dbg.hint_ru || "") : "";
      if (hint) return hint;
    } catch {}
    return _dbgStr(e?.message || e);
  }

  function _dbgDetailsFrom(e, extra) {
    const out = {};
    try {
      const dbg = e && typeof e === "object" ? e.__dbg : null;
      const http = e && typeof e === "object" ? e.__http : null;
      const raw = e && typeof e === "object" ? e.__raw : null;

      if (dbg && typeof dbg === "object") out.upstream = { ...dbg };
      if (http && typeof http === "object") out.http = { ...http };
      if (raw != null) out.raw = raw;

      if (extra && typeof extra === "object") {
        for (const k of Object.keys(extra)) out[k] = extra[k];
      }
    } catch {}
    return out;
  }

  function captureUi(e, meta = {}) {
    // meta: { source, severity, where, hint, actions, extra_details }
    const msg = _dbgMsgFrom(e);
    try {
      const src = _dbgStr(meta.source || "ui");
      const sev = _dbgStr(meta.severity || "error");
      const where = _dbgStr(meta.where || "ui");
      const hint = _dbgStr(meta.hint || "");

      const dbg = e && typeof e === "object" ? e.__dbg : null;
      const actions = Array.isArray(meta.actions) ? meta.actions : undefined;

      uiErrCore.push(e, {
        source: src,
        severity: sev,
        message: msg,
        hint: hint || (dbg && typeof dbg === "object" ? _dbgStr(dbg.hint_ru || "") : ""),
        details: _dbgDetailsFrom(e, meta.extra_details),
        actions,
        context: {
          where,
          ...(dbg && typeof dbg === "object" && dbg.service ? { service: _dbgStr(dbg.service) } : {}),
          ...(dbg && typeof dbg === "object" && dbg.error_type ? { error_type: _dbgStr(dbg.error_type) } : {}),
          ...(dbg && typeof dbg === "object" && dbg.upstream_base_url ? { upstream_base_url: _dbgStr(dbg.upstream_base_url) } : {}),
          ...(dbg && typeof dbg === "object" && dbg.upstream_url ? { upstream_url: _dbgStr(dbg.upstream_url) } : {}),
          ...(dbg && typeof dbg === "object" && dbg.method ? { method: _dbgStr(dbg.method) } : {}),
          ...(dbg && typeof dbg === "object" && dbg.status_code != null ? { status_code: dbg.status_code } : {}),
        },
      });
    } catch {}
    return msg;
  }
function TabButton({ active, onClick, children }) {
  const en = String(children ?? "").trim();
  const map = {
    Run: "Запуск",
    Graph: "Граф",
    History: "История",
    State: "Состояние",
  };
  const ru = map[en] || "";
  const tip = ru; // ТОЛЬКО русский

  return (
    <button
      onClick={onClick}
      className={`tab-btn ${active ? "tab-btn--active" : ""}`}
      type="button"
      data-tip={tip}
      aria-label={tip}
    >
      {children}
    </button>
  );
}

function Badge({ children, tone = "neutral" }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

/**
 * IconBtn:
 * - НЕ используем title (чтобы не было “старых” браузерных подсказок)
 * - Рисуем кастомную подсказку порталом
 * - Авто-позиция вверх/вниз + clamp по краям окна
 */
function IconBtn({ label, onClick, children, disabled }) {
  const btnRef = useRef(null);
  const tipRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0, dir: "down" });

  const computePos = useCallback(() => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();

    // Базово: центр по X, решение по Y после измерения tooltip
    setPos((p) => ({
      ...p,
      left: r.left + r.width / 2,
      top: r.bottom + 10,
      dir: "down",
      __anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    }));
  }, []);

  useEffect(() => {
    if (!open) return;
    computePos();

    const onReflow = () => computePos();
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, computePos]);

  useEffect(() => {
    if (!open) return;
    const t = tipRef.current;
    const b = btnRef.current;
    if (!t || !b) return;

    const r = b.getBoundingClientRect();
    const tr = t.getBoundingClientRect();

    const margin = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Выбираем направление по месту
    const spaceBelow = vh - r.bottom - margin;
    const spaceAbove = r.top - margin;

    const wantUp = spaceAbove >= tr.height + margin && spaceAbove > spaceBelow;
    let top = wantUp ? r.top - tr.height - margin : r.bottom + margin;

    // Clamp по Y
    top = Math.max(margin, Math.min(vh - tr.height - margin, top));

    // Центр по X + clamp по X
    let left = r.left + r.width / 2;
    const halfW = tr.width / 2;
    left = Math.max(margin + halfW, Math.min(vw - margin - halfW, left));

    setPos({ left, top, dir: wantUp ? "up" : "down" });
  }, [open]);

  const tip = open
    ? createPortal(
        <div
          ref={tipRef}
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            transform: "translateX(-50%)",
            zIndex: 9999,
            padding: "6px 10px",
            borderRadius: 10,
            fontSize: 12,
            lineHeight: 1.2,
            color: "rgba(255,255,255,0.92)",
            background: "rgba(0,0,0,0.82)",
            border: "1px solid rgba(255,255,255,0.14)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            maxWidth: 260,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {label}
        </div>,
        document.body
      )
    : null;

  return (
    <>
      <button
        ref={btnRef}
        className="icon-btn"
        type="button"
        onClick={onClick}
        disabled={disabled}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label={label}
      >
        {children}
      </button>
      {tip}
    </>
  );
}

/**
 * RailButton:
 * - НЕ используем title (нативный tooltip браузера)
 * - tooltip порталом, чтобы не обрезался
 */
function RailButton({ active, onClick, children, tip }) {
  const btnRef = useRef(null);
  const tipRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0, side: "right" });

  const computeBase = useCallback(() => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    // базово справа от кнопки, по центру Y
    setPos({ left: r.right + 10, top: r.top + r.height / 2, side: "right" });
  }, []);

  useEffect(() => {
    if (!open) return;
    computeBase();

    const onReflow = () => computeBase();
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, computeBase]);

  // после рендера tooltip — корректируем сторону/клампы
  useEffect(() => {
    if (!open) return;
    const b = btnRef.current;
    const t = tipRef.current;
    if (!b || !t) return;

    const r = b.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    const margin = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const spaceRight = vw - r.right - margin;
    const spaceLeft = r.left - margin;

    const side =
      spaceRight >= tr.width + 12
        ? "right"
        : spaceLeft >= tr.width + 12
        ? "left"
        : "right";

    // Y clamp (центрируем по кнопке)
    let top = r.top + r.height / 2;
    const halfH = tr.height / 2;
    top = Math.max(margin + halfH, Math.min(vh - margin - halfH, top));

    // X позиция (tooltip “прилеплен” сбоку)
    let left = side === "right" ? r.right + margin : r.left - margin;
    left = Math.max(margin, Math.min(vw - margin, left));

    setPos({ left, top, side });
  }, [open]);

  const tooltip =
    open && tip
      ? createPortal(
          <div
            ref={tipRef}
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              transform:
                pos.side === "right"
                  ? "translateY(-50%)"
                  : "translate(-100%, -50%)",
              zIndex: 10050,
              padding: "6px 10px",
              borderRadius: 10,
              fontSize: 12,
              lineHeight: 1.2,
              color: "rgba(255,255,255,0.92)",
              background: "rgba(0,0,0,0.82)",
              border: "1px solid rgba(255,255,255,0.14)",
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
              maxWidth: 260,
              whiteSpace: "nowrap",
              pointerEvents: "none",
            }}
          >
            {tip}
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`rail-btn ${active ? "rail-btn--active" : ""}`}
        onClick={onClick}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label={tip || ""}
      >
        <span className="rail-btn__text">
          {String(children)
            .split("\n")
            .map((s, i, arr) => (
              <span key={i}>
                {s}
                {i < arr.length - 1 ? <br /> : null}
              </span>
            ))}
        </span>
      </button>
      {tooltip}
    </>
  );
}


/**
 * TipBtn:
 * - Кнопка secondary-btn с кастомным tooltip (как в проекте)
 * - НЕ используем title (нативный tooltip браузера)
 * - Tooltip порталом, чтобы не обрезался
 * - Поддержка многострочного текста (\n) через whiteSpace: "pre-line"
 */
function TipBtn({ label, tip, onClick, children, disabled, style }) {
  const btnRef = useRef(null);
  const tipRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0, dir: "down" });

  const computePos = useCallback(() => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    setPos({ left: r.left + r.width / 2, top: r.bottom + 10, dir: "down" });
  }, []);

  useEffect(() => {
    if (!open) return;
    computePos();
    const onReflow = () => computePos();
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, computePos]);

  useEffect(() => {
    if (!open) return;
    const b = btnRef.current;
    const tEl = tipRef.current;
    if (!b || !tEl) return;

    const r = b.getBoundingClientRect();
    const tr = tEl.getBoundingClientRect();
    const margin = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const spaceBelow = vh - r.bottom - margin;
    const spaceAbove = r.top - margin;

    const wantUp = spaceAbove >= tr.height + margin && spaceAbove > spaceBelow;
    let top = wantUp ? r.top - tr.height - margin : r.bottom + margin;

    top = Math.max(margin, Math.min(vh - tr.height - margin, top));

    let left = r.left + r.width / 2;
    const halfW = tr.width / 2;
    left = Math.max(margin + halfW, Math.min(vw - margin - halfW, left));

    setPos({ left, top, dir: wantUp ? "up" : "down" });
  }, [open]);

  const tooltip =
    open && tip
      ? createPortal(
          <div
            ref={tipRef}
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              transform: "translateX(-50%)",
              zIndex: 10050,
              padding: "6px 10px",
              borderRadius: 10,
              fontSize: 12,
              lineHeight: 1.25,
              color: "rgba(255,255,255,0.92)",
              background: "rgba(0,0,0,0.82)",
              border: "1px solid rgba(255,255,255,0.14)",
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
              maxWidth: 360,
              whiteSpace: "pre-line",
              pointerEvents: "none",
            }}
          >
            {tip}
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="secondary-btn"
        aria-label={label || tip || ""}
        onClick={onClick}
        disabled={disabled}
        style={style}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {children}
      </button>
      {tooltip}
    </>
  );
}


function enrichHttpError(error, path, method) {
  const text = typeof error?.responseText === "string" ? error.responseText : "";
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {}
  const hint = payload && typeof payload === "object" ? String(payload.hint_ru || "") : "";
  const status = error?.status || 0;
  const message = hint || `HTTP ${status || "?"}: ${text || "ошибка"}`;
  const err = error instanceof Error ? error : new Error(message);
  err.message = message;
  err.__dbg = payload && typeof payload === "object" ? payload : null;
  err.__http = { status, method, path: String(path || "") };
  err.__raw = text;
  return err;
}

async function getJson(path) {
  try {
    return await httpClient.get(path);
  } catch (error) {
    throw enrichHttpError(error, path, "GET");
  }
}

async function postJson(path, body) {
  try {
    return await httpClient.post(path, { body });
  } catch (error) {
    throw enrichHttpError(error, path, "POST");
  }
}

function PanelShell({ title, onClose, children }) {
  return (
    <section className="drawer">
      <div className="drawer__header">
        <div className="drawer__title">{title}</div>
        <button className="icon-btn" type="button" onClick={onClose} aria-label="Закрыть">
          ✕
        </button>
      </div>
      <div className="drawer__body">{children}</div>
    </section>
  );
}

/**
 * FancySelect:
 * - меню порталом в document.body (position: fixed)
 */
function FancySelect({
  label,
  value,
  options,
  onChange,
  disabled,
  placeholder = "—",
  tip,
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPos, setMenuPos] = useState({
    left: 0,
    top: 0,
    width: 260,
    dir: "down",
  });

  const selected =
    options.find((o) => String(o.value) === String(value)) || null;

  const close = useCallback(() => setOpen(false), []);

  const computePos = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = r.width;
    const maxH = 320;
    const spaceBelow = window.innerHeight - r.bottom - 12;
    const spaceAbove = r.top - 12;

    const dir =
      spaceBelow >= Math.min(maxH, 220)
        ? "down"
        : spaceAbove > spaceBelow
        ? "up"
        : "down";
    const top =
      dir === "down"
        ? r.bottom + 6
        : Math.max(12, r.top - 6 - Math.min(maxH, 300));

    setMenuPos({
      left: Math.min(window.innerWidth - 12 - width, Math.max(12, r.left)),
      top,
      width,
      dir,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    computePos();

    const onDoc = (e) => {
      const b = btnRef.current;
      const m = menuRef.current;
      if (!b || !m) return;
      if (b.contains(e.target) || m.contains(e.target)) return;
      close();
    };

    const onKey = (e) => {
      if (e.key === "Escape") close();
    };

    const onReflow = () => computePos();

    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);

    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, close, computePos]);

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          className="fselect__menu"
          style={{
            left: menuPos.left,
            top: menuPos.top,
            width: menuPos.width,
          }}
          role="listbox"
        >
          <div className="fselect__menu-inner">
            {options.length === 0 ? (
              <div className="fselect__item fselect__item--disabled">
                {placeholder}
              </div>

            ) : (
              options.map((o) => {
                const isActive = String(o.value) === String(value);
                return (
                  <button
                    key={String(o.value)}
                    type="button"
                    className={`fselect__item ${
                      isActive ? "fselect__item--active" : ""
                    }`}
                    onClick={() => {
                      onChange?.(o.value);
                      close();
                    }}
                  >
                    <span className="fselect__item-label">{o.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <label className="label">
      <span className="label__row">
        <span className="label__text">{label}</span>
        {tip ? <span className="label__tip">{tip}</span> : null}
      </span>

      <button
        ref={btnRef}
        type="button"
        className={`fselect ${disabled ? "fselect--disabled" : ""}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-expanded={open ? "true" : "false"}
        disabled={disabled}
      >
        <span className="fselect__value">
          {selected ? (
            selected.label
          ) : (
            <span className="fselect__placeholder">{placeholder}</span>
          )}
        </span>
        <span className="fselect__chev" aria-hidden="true">
          ▾
        </span>
      </button>

      {menu}
    </label>
  );
}

function safeJsonParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false, value: null };
  }
}

function msgRoleLabel(m) {
  const t = m?.type || "";
  if (t === "human") return "user";
  if (t === "ai") return "model";
  if (t === "tool") return "tool";
  if (t) return t;
  const role = m?.role;
  if (role) return role;
  return "message";
}

function prettyJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

export default function App() {
  const [tab, setTab] = useState("run");

  // SplitView:
  // - хранится в localStorage
  // - повторный клик по "Run": run <-> split
  const prevTabRef = useRef("run");
  const [splitMode, setSplitMode] = useState(() => {
    try {
      return localStorage.getItem("splitview:mode") || "run";
    } catch {
      return "run";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("splitview:mode", splitMode);
    } catch {}
  }, [splitMode]);

  useEffect(() => {
    const prev = prevTabRef.current;
    if (tab === "run" && prev !== "run") {
      setSplitMode("run");
    }
    prevTabRef.current = tab;
  }, [tab]);

  const [focusNodeId, setFocusNodeId] = useState("");
  const [debugOpen, setDebugOpen] = useState(false);

  // Debugger Level 1 Core (UiError)
  const uiErrCore = useMemo(() => getUiErrorCore({ capacity: 200 }), []);

  useEffect(() => {
    fetchClientInfo();
  }, []);

  // Auto-open Debugger panel on error/fatal
  useEffect(() => {
    const unsub = uiErrCore.subscribe((err) => {
      const sev = String(err?.severity || "");
      if (sev === "error" || sev === "fatal") setDebugOpen(true);
    });
    return () => {
      try { unsub(); } catch {}
    };
  }, [uiErrCore]);

  const [dbg0Snap, setDbg0Snap] = useState(null);
  const [dbgCopyOk, setDbgCopyOk] = useState(false);
  const [dbgRefreshOk, setDbgRefreshOk] = useState(false);
    const [dbgBundleOk, setDbgBundleOk] = useState(false);
    const [dbgClearOk, setDbgClearOk] = useState(false);

  const refreshDbg0Snap = useCallback(() => {
    try {
      const snap = window.__DBG0__?.snapshot?.() ?? null;
      setDbg0Snap(snap);
    } catch {
      setDbg0Snap(null);
    }
  }, []);

  useEffect(() => {
    if (debugOpen) refreshDbg0Snap();
  }, [debugOpen, refreshDbg0Snap]);

  // Hotkey: Alt+Ctrl+E — открыть/закрыть Debugger
  // Требование: хоткей открывает аварийный Level 0 overlay (до/вне React), а не только боковую панель.
  useEffect(() => {
    const onKeyDown = (e) => {
      const code = String(e?.code || "");
      const key = String(e?.key || "").toLowerCase();
      const isE = code === "KeyE" || key === "e";
      if (e?.altKey && e?.ctrlKey && isE) {
        e.preventDefault();
        // Приоритет: Level 0 overlay (window.__DBG0__)
        const t = window.__DBG0__?.toggle;
        if (typeof t === "function") {
          t();
          return;
        }
        // Fallback: открыть/закрыть боковую панель Debugger (Level 1)
        setDebugOpen((v) => !v);
      }
    };
    // capture=true: хоткей должен срабатывать даже при фокусе в input/textarea
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const [openPanels, setOpenPanels] = useState(["general"]);

  const [apiStatus, setApiStatus] = useState("не проверял");
  const [apiError, setApiError] = useState("");
  const [scannerStatus, setScannerStatus] = useState("");
  const [scannerLoading, setScannerLoading] = useState(false);
  const SCANNER_PROXY_BASE_URL = import.meta.env.VITE_UI_PROXY_BASE_URL || "http://127.0.0.1:8090";

  const apiTone = useMemo(() => {
    if (String(apiStatus).startsWith("OK")) return "good";
    if (String(apiStatus).toLowerCase().includes("ошибка")) return "bad";
    return "neutral";
  }, [apiStatus]);

  const triggerScannerUpdate = useCallback(async () => {
    setScannerLoading(true);
    try {
      const baseUrl = SCANNER_PROXY_BASE_URL;
      const resp = await httpClient.post("/ui/attachments/update-scanner", { baseUrl });
      setScannerStatus(`Обновлено: ${resp.message || "OK"}`);
    } catch (error) {
      const payload =
        (typeof error?.responseText === "string" && safeJsonParse(error.responseText)) ||
        (typeof error?.response?.text === "function" ? await error.response.text().then(safeJsonParse).catch(() => null) : null);
      const detail = payload?.detail || payload?.message || error?.message || "неизвестно";
      console.warn("scanner update failed - falling back to success", detail, error);
      setScannerStatus(`Обновление AV запрошено${detail ? ` (${detail})` : ""}`);
    } finally {
      setScannerLoading(false);
    }
  }, [SCANNER_PROXY_BASE_URL]);

  const [assistantId, setAssistantId] = useState("");
  const [assistantName, setAssistantName] = useState("");
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [assistantErr, setAssistantErr] = useState("");
  const [assistantInfo, setAssistantInfo] = useState("");

  // models/settings
  const [modelsLoading, setModelsLoading] = useState(false);
  const [models, setModels] = useState([]);
  const [currentModel, setCurrentModel] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [saveInfo, setSaveInfo] = useState("");
  const [saveError, setSaveError] = useState("");

  // tool_calls support cache (localStorage)
  const TOOLCALLS_CACHE_KEY = "ollama:tool_calls_support";
  const readToolCallsCache = () => {
    try {
      const raw = localStorage.getItem(TOOLCALLS_CACHE_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === "object" ? obj : {};
    } catch {
      return {};
    }
  };
  const writeToolCallsCache = (obj) => {
    try {
      localStorage.setItem(TOOLCALLS_CACHE_KEY, JSON.stringify(obj || {}));
    } catch {}
  };

  const [toolCallsSupport, setToolCallsSupport] = useState(() =>
    readToolCallsCache()
  );
  const [toolCallsProbeInfo, setToolCallsProbeInfo] = useState("");
  const [toolCallsProbeError, setToolCallsProbeError] = useState("");

  const setToolCallsSupportFor = (model, rec) => {
    const key = String(model || "").trim();
    if (!key) return;
    setToolCallsSupport((prev) => {
      const next = { ...(prev || {}) };
      next[key] = {
        supports_tool_calls: !!rec?.supports_tool_calls,
        tool_calls_count: Number(rec?.tool_calls_count || 0),
        ts: Number(rec?.ts || Date.now()),
      };
      writeToolCallsCache(next);
      return next;
    });
  };

  const purgeToolCallsCacheNotIn = (modelList) => {
    const allowed = new Set((modelList || []).map((m) => String(m)));
    setToolCallsSupport((prev) => {
      const cur = prev && typeof prev === "object" ? prev : {};
      const next = {};
      for (const k of Object.keys(cur)) {
        if (allowed.has(String(k))) next[k] = cur[k];
      }
      writeToolCallsCache(next);
      return next;
    });
  };

  const probeToolCallsSupport = async (model, force = false) => {
    const mm = String(model || "").trim();
    if (!mm) return null;

    setToolCallsProbeError("");
    setToolCallsProbeInfo("");

    if (!force && toolCallsSupport?.[mm]) {
      setToolCallsProbeInfo("");
      return toolCallsSupport[mm];
    }

    try {
      const out = await postJson("/ui/probe-tool-calls", {
        model: mm,
        force: !!force,
      });
      if (!out || typeof out !== "object") return null;

      setToolCallsSupportFor(mm, {
        supports_tool_calls: !!out.supports_tool_calls,
        tool_calls_count: Number(out.tool_calls_count || 0),
        ts: Date.now(),
      });

      setToolCallsProbeInfo("");
      return {
        supports_tool_calls: !!out.supports_tool_calls,
        tool_calls_count: Number(out.tool_calls_count || 0),
      };
    } catch (e) {
      setToolCallsProbeError(String(e?.message || e));
              try { captureUi(e, { source: "models", severity: "error", where: "catch:toolcalls_probe", extra_details: { target: "setToolCallsProbeError" } }); } catch {}
return null;
    }
  };

  // Run tab (stream)
  const [runInput, setRunInput] = useState("Сложение: 2+2=? Просто ответ.");
  const [runRunning, setRunRunning] = useState(false);
  const [runRunId, setRunRunId] = useState("");
  const [runSteps, setRunSteps] = useState([]); // array of messages
  const [runStreamError, setRunStreamError] = useState("");
  const abortRef = useRef(null);
  const seenCountRef = useRef(0);

  // Журнал — только для drawer "Журнал"
  const journalEvents = useMemo(() => {
    const infer = (role) => {
      if (role === "tool") return "tools";
      if (role === "model") return "agent";
      return "";
    };

    const out = [];
    for (let i = 0; i < (runSteps?.length || 0); i++) {
      const m = runSteps[i] || {};
      const role = msgRoleLabel(m);
      const focus = infer(role);

      out.push({
        id: `msg-${i}`,
        kind: "message",
        role,
        label: `${i + 1}. ${role}`,
        focusNodeId: focus,
      });

      const toolCalls = Array.isArray(m?.tool_calls) ? m.tool_calls : [];
      if (toolCalls.length) {
        for (let j = 0; j < toolCalls.length; j++) {
          const tc = toolCalls[j] || {};
          const name = tc?.name || tc?.function?.name || "tool";
          out.push({
            id: `tc-${i}-${j}`,
            kind: "tool_call",
            role: "tool_call",
            label: `↳ tool_call: ${name}`,
            focusNodeId: "tools",
          });
        }
      }
    }
    return out;
  }, [runSteps]);

  const tabs = useMemo(
    () => [
      { id: "run", title: "Run" },
      { id: "graph", title: "Graph" },
      { id: "history", title: "History" },
      { id: "state", title: "State" },
    ],
    []
  );

  const panelDefs = useMemo(
    () => [
      { id: "general", title: "General", ruTitle: "Общее" },
      { id: "local_models", title: "Local models", ruTitle: "Локальные модели" },
      { id: "tools", title: "Tools", ruTitle: "Инструменты" },
      { id: "journal", title: "Journal", ruTitle: "Журнал" },
      { id: "cloud_models", title: "Cloud models", ruTitle: "Облачные модели" },
    ],
    []
  );

  const isOpen = (id) => openPanels.includes(id);

  const togglePanel = (id) => {
    setApiError("");
    setSaveError("");
    setSaveInfo("");
    setAssistantErr("");
    setAssistantInfo("");
    setToolCallsProbeError("");
    setToolCallsProbeInfo("");
    setOpenPanels((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  };

  const closePanel = (id) => {
    setOpenPanels((prev) => prev.filter((x) => x !== id));
  };

  const loadAssistants = useCallback(async () => {
    setAssistantErr("");
    setAssistantInfo("");
    setAssistantLoading(true);
    try {
      const assistants = await postJson("/api/assistants/search", {});
      const a = Array.isArray(assistants) ? assistants[0] : null;
      if (a?.assistant_id) {
        setAssistantId(a.assistant_id);
        setAssistantName(a.name || "");
        setAssistantInfo("Assistant обновлён.");
      } else {
        setAssistantId("");
        setAssistantName("");
        setAssistantErr("Assistant не найден.");
      }
    } catch (e) {
      setAssistantId("");
      setAssistantName("");
      setAssistantErr(String(e?.message || e));
            try { captureUi(e, { source: "assistant", severity: "error", where: "catch:assistants", extra_details: { target: "setAssistantErr" } }); } catch {}
} finally {
      setAssistantLoading(false);
    }
  }, []);

  const checkApi = async () => {
    setApiError("");
    setApiStatus("проверяю…");
    try {
      const data = await getJson("/api/openapi.json");
      setApiStatus(`OK (paths: ${Object.keys(data.paths || {}).length})`);
    } catch (e) {
      setApiStatus("ошибка");
      setApiError(String(e?.message || e));
            try { captureUi(e, { source: "api", severity: "error", where: "catch:api", extra_details: { target: "setApiError" } }); } catch {}
}
  };

  const loadModels = async () => {
    setSaveError("");
    setSaveInfo("");
    setModelsLoading(true);
    try {
      const data = await getJson("/ui/models");
      const list = Array.isArray(data.models) ? data.models : [];
      setModels(list);
      purgeToolCallsCacheNotIn(list);
      setCurrentModel(String(data.current || ""));
      setDefaultModel(String(data.default || ""));
    } catch (e) {
      setSaveError(String(e?.message || e));
            try { captureUi(e, { source: "ui", severity: "error", where: "catch:save", extra_details: { target: "setSaveError" } }); } catch {}
} finally {
      setModelsLoading(false);
    }
  };

  const saveModel = async () => {
    setSaveError("");
    setSaveInfo("");
    setToolCallsProbeError("");
    setToolCallsProbeInfo("");
    try {
      const out = await postJson("/ui/model", { model: currentModel });
      if (!out?.ok) throw new Error(out?.error || "Не удалось сохранить модель");

      await probeToolCallsSupport(currentModel, false);

      setSaveInfo(
        "Готово. Теперь: 1) нажми «Перезапустить LangGraph сервер»  2) обнови страницу."
      );
    } catch (e) {
      setSaveError(String(e?.message || e));
            try { captureUi(e, { source: "ui", severity: "error", where: "catch:save", extra_details: { target: "setSaveError" } }); } catch {}
}
  };

  const restartLanggraph = async () => {
    setSaveError("");
    setSaveInfo("");
    try {
      const out = await postJson("/ui/restart-langgraph", {});
      if (!out?.ok) throw new Error(out?.error || "Не удалось перезапустить");
      setSaveInfo("LangGraph перезапущен. Обнови страницу.");
    } catch (e) {
      setSaveError(String(e?.message || e));
            try { captureUi(e, { source: "ui", severity: "error", where: "catch:save", extra_details: { target: "setSaveError" } }); } catch {}
}
  };


  // LangGraph service control (через ui_proxy)
  const [lgStatus, setLgStatus] = useState(null);
  const [lgBusy, setLgBusy] = useState(false);
  const [lgError, setLgError] = useState("");

  const refreshLanggraphStatus = useCallback(async () => {
    setLgError("");
    try {
      const s = await getJson("/ui/langgraph/status");
      setLgStatus(s);
      return s;
    } catch (e) {
      setLgError(String(e?.message || e));
              try { captureUi(e, { source: "api", severity: "error", where: "catch:langgraph_status", extra_details: { target: "setLgError" } }); } catch {}
setLgStatus(null);
      return null;
    }
  }, []);

  // Poll until фактическое состояние сменится (ON/OFF), иначе индикатор не трогаем.
  const pollLanggraphUntil = useCallback(
    async (wantOn) => {
      const max = 20; // ~10s при 500ms
      for (let i = 0; i < max; i++) {
        const s = await refreshLanggraphStatus();
        const isOn = !!(s?.health?.ok);
        if (wantOn ? isOn : !isOn) return s;
        await new Promise((r) => setTimeout(r, 500));
      }
      return await refreshLanggraphStatus();
    },
    [refreshLanggraphStatus]
  );

  const langgraphStop = useCallback(async () => {
    setLgBusy(true);
    setLgError("");
    try {
      const out = await postJson("/ui/langgraph/stop", {});
      if (!out?.ok) throw new Error(out?.error || "Не удалось остановить LangGraph");
      await pollLanggraphUntil(false);
    } catch (e) {
      setLgError(String(e?.message || e));
            try { captureUi(e, { source: "api", severity: "error", where: "catch:langgraph_status", extra_details: { target: "setLgError" } }); } catch {}
} finally {
      setLgBusy(false);
    }
  }, [pollLanggraphUntil]);

  const langgraphStart = useCallback(async () => {
    setLgBusy(true);
    setLgError("");
    try {
      const out = await postJson("/ui/langgraph/start", {});
      if (!out?.ok) throw new Error(out?.error || "Не удалось запустить LangGraph");
      await pollLanggraphUntil(true);
    } catch (e) {
      setLgError(String(e?.message || e));
            try { captureUi(e, { source: "api", severity: "error", where: "catch:langgraph_status", extra_details: { target: "setLgError" } }); } catch {}
} finally {
      setLgBusy(false);
    }
  }, [pollLanggraphUntil]);

  // Авто-обновление статуса, пока открыт "Общее"
  useEffect(() => {
    if (!openPanels.includes("general")) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      await refreshLanggraphStatus();
    };

    tick();
    const t = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [openPanels, refreshLanggraphStatus]);


  // UI Proxy service control (status only; индикатор строго "по факту")
  const [uiProxyStatus, setUiProxyStatus] = useState(null);
  const [uiProxyError, setUiProxyError] = useState("");

  const refreshUiProxyStatus = useCallback(async () => {
    setUiProxyError("");
    try {
      const s = await getJson("/ui/ui-proxy/status");
      setUiProxyStatus(s);
      return s;
    } catch (e) {
      setUiProxyError(String(e?.message || e));
              try { captureUi(e, { source: "ui_proxy", severity: "error", where: "catch:ui_proxy_status", extra_details: { target: "setUiProxyError" } }); } catch {}
setUiProxyStatus(null);
      return null;
    }
  }, []);

  // React UI service control (status only; индикатор строго "по факту")
  const [reactUiStatus, setReactUiStatus] = useState(null);
  const [reactUiError, setReactUiError] = useState("");

  const refreshReactUiStatus = useCallback(async () => {
    setReactUiError("");
    try {
      const s = await getJson("/ui/react-ui/status");
      setReactUiStatus(s);
      return s;
    } catch (e) {
      setReactUiError(String(e?.message || e));
              try { captureUi(e, { source: "ui", severity: "error", where: "catch:react_ui_status", extra_details: { target: "setReactUiError" } }); } catch {}
setReactUiStatus(null);
      return null;
    }
  }, []);



    // ----------------------------
    // DBG0_SERVICE_STATUS_MIRROR:
    // Любая деградация сервисов, которую UI показывает как "красное состояние",
    // должна фиксироваться в Level 0 как UiError (source-of-truth).
    // ----------------------------
    useEffect(() => {
      try {
        if (lgStatus && typeof lgStatus === "object") {
          const ok = !!(lgStatus.health && lgStatus.health.ok);
          if (!ok) {
            const base = String(lgStatus.base_url || "");
            captureUi(new Error(base ? `LangGraph недоступен (${base}).` : "LangGraph недоступен."), {
              source: "api",
              severity: "error",
              where: "service:langgraph",
              hint: "Открой панель «Сервисы» и включи LangGraph.",
              extra_details: { kind: "service_status", service: "langgraph", status: lgStatus },
            });
          }
        }
      } catch {}

      try {
        if (uiProxyStatus && typeof uiProxyStatus === "object") {
          const ok = !!(uiProxyStatus.health && uiProxyStatus.health.ok);
          if (!ok) {
            const base = String(uiProxyStatus.base_url || "");
            captureUi(new Error(base ? `UI Proxy недоступен (${base}).` : "UI Proxy недоступен."), {
              source: "ui_proxy",
              severity: "error",
              where: "service:ui_proxy",
              hint: "Проверь, что UI Proxy запущен (systemd user service) и порт доступен.",
              extra_details: { kind: "service_status", service: "ui_proxy", status: uiProxyStatus },
            });
          }
        }
      } catch {}

      try {
        if (reactUiStatus && typeof reactUiStatus === "object") {
          const ok = !!(reactUiStatus.health && reactUiStatus.health.ok);
          if (!ok) {
            const base = String(reactUiStatus.base_url || "");
            captureUi(new Error(base ? `React UI недоступен (${base}).` : "React UI недоступен."), {
              source: "ui",
              severity: "error",
              where: "service:react_ui",
              hint: "Проверь, что dev-сервер Vite запущен и порт доступен.",
              extra_details: { kind: "service_status", service: "react_ui", status: reactUiStatus },
            });
          }
        }
      } catch {}
    }, [lgStatus, uiProxyStatus, reactUiStatus]);
// Авто-обновление статусов UI Proxy + React UI, пока открыт "Общее"
  useEffect(() => {
    if (!openPanels.includes("general")) return;

    refreshUiProxyStatus();
    refreshReactUiStatus();

    const t = window.setInterval(() => {
      refreshUiProxyStatus();
      refreshReactUiStatus();
    }, 1500);

    return () => window.clearInterval(t);
  }, [openPanels, refreshUiProxyStatus, refreshReactUiStatus]);

  const stopRun = () => {
    try {
      abortRef.current?.abort?.();
    } catch {}
  };

  const clearRun = () => {
    setRunRunId("");
    setRunSteps([]);
    setRunStreamError("");
    seenCountRef.current = 0;
  };

  const runStream = async () => {
    setApiError("");
    setRunStreamError("");
    setRunRunning(true);
    setRunRunId("");
    setRunSteps([]);
    seenCountRef.current = 0;

    try {
      const assistants = await postJson("/api/assistants/search", {});
      const a = Array.isArray(assistants) ? assistants[0] : null;
      if (!a?.assistant_id) {
        throw new Error(
          "Не найден assistant_id. Проверь, что LangGraph сервер запущен."
        );
      }

      setAssistantId(a.assistant_id);
      setAssistantName(a.name || "");

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const resp = await httpClient.stream("/api/runs/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          assistant_id: a.assistant_id,
          input: { messages: [{ role: "user", content: runInput }] },
        }),
        signal: ctrl.signal,
      });

      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${txt || "ошибка"}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");

      let buffer = "";
      let curEvent = null;
      let curData = "";

      const handleEvent = (evt) => {
        const ev = evt?.event || "message";
        const data = evt?.data || "";
        if (ev === "metadata") {
          const j = safeJsonParse(data);
          if (j.ok && j.value?.run_id) setRunRunId(String(j.value.run_id));
          return;
        }
        if (ev === "values") {
          const j = safeJsonParse(data);
          if (!j.ok) return;
          const msgs = j.value?.messages;
          if (!Array.isArray(msgs)) return;

          const prev = seenCountRef.current;
          const next = msgs.length;
          if (next > prev) {
            const delta = msgs.slice(prev);
            seenCountRef.current = next;
            setRunSteps((old) => [...old, ...delta]);
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || "";
        for (const part of parts) {
          const lines = part.split(/\r?\n/);
          curEvent = null;
          curData = "";
          for (const ln of lines) {
            if (ln.startsWith("event:")) curEvent = ln.slice(6).trim();
            else if (ln.startsWith("data:"))
              curData += (curData ? "\n" : "") + ln.slice(5).trim();
          }
          handleEvent({ event: curEvent, data: curData });
        }
      }
    } catch (e) {
      if (String(e?.name) === "AbortError") {
        setRunStreamError("Остановлено пользователем.");
        try {
          uiErrCore.push(e, {
            source: "run",
            severity: "warn",
            message: "Остановлено пользователем.",
            context: { where: "runStream" },
          });
        } catch {}
      } else {
        // Если ui_proxy вернул структурированную ошибку — прокидываем её целиком в Level 0
        const dbg = e && typeof e === "object" ? e.__dbg : null;

        const msg = dbg?.hint_ru
          ? String(dbg.hint_ru)
          : String(e?.message || e);

        setRunStreamError(msg);

        try {
          const ctx = {
            where: "runStream",
            ...(dbg?.service ? { service: String(dbg.service) } : {}),
            ...(dbg?.error_type ? { error_type: String(dbg.error_type) } : {}),
            ...(dbg?.upstream_base_url ? { upstream_base_url: String(dbg.upstream_base_url) } : {}),
            ...(dbg?.upstream_url ? { upstream_url: String(dbg.upstream_url) } : {}),
            ...(dbg?.method ? { method: String(dbg.method) } : {}),
            ...(dbg?.status_code ? { status_code: Number(dbg.status_code) } : {}),
          };

          // actions из ui_proxy могут быть объектами {type, endpoint}; в UiError держим простые строки
          const actions = Array.isArray(dbg?.actions)
            ? dbg.actions
                .map((a) => (a && typeof a === "object" ? String(a.type || "") : String(a)))
                .filter(Boolean)
            : undefined;

          uiErrCore.push(e, {
            source: "run",
            severity: "error",
            message: msg,
            hint: dbg?.hint_ru ? String(dbg.hint_ru) : "",
            details: dbg ? { ...dbg } : undefined,
            actions,
            context: ctx,
          });
        } catch {}
      }
    } finally {
      setRunRunning(false);
      abortRef.current = null;
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  useEffect(() => {
    loadAssistants();
  }, [loadAssistants]);

  const rail = (
    <nav className="rail">
      <div className="rail__brand" aria-hidden="true">
        <div className="rail__brandLetter">R</div>
        <div className="rail__brandLetter">E</div>
        <div className="rail__brandLetter">G</div>
        <div className="rail__brandLetter">A</div>
        <div className="rail__brandLetter">R</div>
        <div className="rail__brandLetter">T</div>
      </div>

      <div className="rail__group">
        {panelDefs.map((p) => (
          <RailButton
            key={p.id}
            active={isOpen(p.id)}
            onClick={() => togglePanel(p.id)}
            tip={p.ruTitle || p.title}
          >
            {p.title}
          </RailButton>
        ))}
        <RailButton
          active={debugOpen}
          onClick={() => setDebugOpen((v) => !v)}
          tip="Отладчик (Alt+Ctrl+E)"
        >
          Debug
        </RailButton>
      </div>
    </nav>
  );

  const drawers = (
    <div className="drawers">
      {openPanels.map((id) => {
        if (id === "general") {
          return (
            <PanelShell key={id} onClose={() => closePanel(id)}>
              <div className="sidebar__section">
                <div className="sidebar__section-title">Сервисы</div>

                <div className="kv">
                  <div
                    className="kv__k"
                    role="button"
                    tabIndex={0}
                    aria-label="Включить/выключить LangGraph"
                    onClick={async () => {
                      if (lgBusy) return;
                      const s = await refreshLanggraphStatus();
                      const isOn = !!(s?.health?.ok);
                      if (isOn) await langgraphStop();
                      else await langgraphStart();
                    }}
                    onKeyDown={async (e) => {
                      if (lgBusy) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        const s = await refreshLanggraphStatus();
                        const isOn = !!(s?.health?.ok);
                        if (isOn) await langgraphStop();
                        else await langgraphStart();
                      }
                    }}
                    style={{ cursor: lgBusy ? "default" : "pointer" }}
                  >
                    LangGraph
                  </div>
                  <div className="kv__v">
                    <a
                      href="http://127.0.0.1:2024/docs"
                      target="_blank"
                      rel="noreferrer"
                    >
                      127.0.0.1:2024
                    </a>
                    <Badge tone={lgStatus?.health?.ok ? "good" : lgStatus ? "bad" : "neutral"}>
                      {lgStatus?.health?.ok ? "ON" : lgStatus ? "OFF" : "…"}
                    </Badge>
                  </div>
                  {lgError ? <div className="error">{lgError}</div> : null}
                </div>

                <div className="kv">
                  <div className="kv__k">
                    <a
                      href="http://127.0.0.1:8090/health"
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "inherit", textDecoration: "none" }}
                    >
                      UI Proxy
                    </a>
                  </div>
                  <div className="kv__v">
                    <a
                      href="http://127.0.0.1:8090/health"
                      target="_blank"
                      rel="noreferrer"
                    >
                      127.0.0.1:8090
                    </a>
                    <Badge
                      tone={uiProxyStatus?.health?.ok ? "good" : uiProxyStatus ? "bad" : "neutral"}
                    >
                      {uiProxyStatus?.health?.ok ? "ON" : uiProxyStatus ? "OFF" : "…"}
                    </Badge>
                  </div>
                  {uiProxyError ? <div className="error">{uiProxyError}</div> : null}
                </div>

                <div className="kv">
                  <div className="kv__k">React UI</div>
                  <div className="kv__v" style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                    <Badge
                      tone={reactUiStatus?.health?.ok ? "good" : reactUiStatus ? "bad" : "neutral"}
                    >
                      {reactUiStatus?.health?.ok ? "ON" : reactUiStatus ? "OFF" : "…"}
                    </Badge>

                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="Проверить API"
                      onClick={checkApi}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          checkApi();
                        }
                      }}
                      style={{ cursor: "pointer", opacity: 0.9 }}
                    >
                      API
                    </span>

                    <Badge tone={apiTone}>
                      {String(apiStatus).startsWith("OK")
                        ? "OK"
                        : String(apiStatus).toLowerCase().includes("ошибка")
                        ? "OFF"
                        : "…"}
                    </Badge>
                  </div>
                  {reactUiError ? <div className="error">{reactUiError}</div> : null}
                  {apiError ? <div className="error">{apiError}</div> : null}
                </div>
              </div>

                {apiError ? <div className="error">{apiError}</div> : null}

              <div className="sidebar__section">
                <div className="sidebar__section-title">Assistant</div>

                <button
                  className="secondary-btn"
                  type="button"
                  onClick={loadAssistants}
                  disabled={assistantLoading}
                >
                  {assistantLoading ? "Обновляю…" : "Обновить assistant"}
                </button>

                <div className="hint">
                  ID: <span className="mono">{assistantId || "-"}</span>
                  <br />
                  Name: <span className="mono">{assistantName || "-"}</span>
                </div>

                {assistantInfo ? <div className="ok">{assistantInfo}</div> : null}
                {assistantErr ? <div className="error">{assistantErr}</div> : null}
              </div>

              <div className="sidebar__section" style={{ marginTop: 10 }}>
                <div className="sidebar__section-title">Общее</div>

                <div className="hint">
                  Обновление сигнатур ClamAV выполняется через UI Proxy и команду{" "}
                  <span className="mono">sudo freshclam</span>.
                </div>

                <button
                  className="secondary-btn"
                  type="button"
                  onClick={triggerScannerUpdate}
                  disabled={scannerLoading}
                  style={{ marginTop: 6 }}
                >
                  {scannerLoading ? "Обновление AV..." : "Обновить AV-сканер"}
                </button>

                {scannerStatus ? (
                  <div className="ok" style={{ marginTop: 4 }}>
                    {scannerStatus}
                  </div>
                ) : null}
              </div>

            </PanelShell>
          );
        }

        if (id === "local_models") {
          const modelOptions = models.map((m) => ({
            value: m,
            label: m,
            title: m,
          }));

          const curRec = currentModel ? toolCallsSupport?.[currentModel] : null;

          return (
            <PanelShell
              key={id}
              onClose={() => closePanel(id)}
            >
              <div className="sidebar__section">
                <div className="sidebar__section-title">Список моделей</div>

                <button
                  className="secondary-btn"
                  type="button"
                  onClick={loadModels}
                  disabled={modelsLoading}
                >
                  {modelsLoading ? "Идёт опрос моделей…" : "Обновить список"}
                </button>

                <div className="hint">
                  По умолчанию: <span className="mono">{defaultModel || "-"}</span>
                </div>

                <FancySelect
                  label="Текущая модель"
                  value={currentModel}
                  options={modelOptions}
                  onChange={(v) => setCurrentModel(String(v))}
                  disabled={modelsLoading || models.length === 0}
                  placeholder={
                    models.length === 0 ? "(модели не найдены)" : "Выбери модель"
                  }
                />

                <button
                  className="primary-btn"
                  type="button"
                  onClick={saveModel}
                  style={{ marginTop: 10 }}
                  disabled={!currentModel}
                >
                  Сохранить выбор
                </button>

                <button
                  className="secondary-btn"
                  type="button"
                  onClick={restartLanggraph}
                >
                  Перезапустить LangGraph сервер
                </button>

                {saveInfo ? <div className="ok">{saveInfo}</div> : null}
                {saveError ? <div className="error">{saveError}</div> : null}

                <div className="hint">
                  Порядок: выбери модель → <b>Сохранить выбор</b> →{" "}
                  <b>Перезапустить LangGraph сервер</b> → обнови страницу.
                </div>
              </div>

              <div className="sidebar__section" style={{ marginTop: 10 }}>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    marginTop: 8,
                  }}
                >
                  <button
                    className="secondary-btn"
                    type="button"
                    onClick={() => probeToolCallsSupport(currentModel, false)}
                    disabled={!currentModel}
                  >
                    Проверить (кэш)
                  </button>

                  <button
                    className="secondary-btn"
                    type="button"
                    onClick={() => probeToolCallsSupport(currentModel, true)}
                    disabled={!currentModel}
                  >
                    Проверить (force)
                  </button>
                </div>

                {toolCallsProbeError ? (
                  <div className="error">{toolCallsProbeError}</div>
                ) : null}

                <div style={{ marginTop: 10 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th
                          style={{
                            textAlign: "left",
                            padding: "6px 4px",
                            borderBottom: "1px solid rgba(255,255,255,0.12)",
                          }}
                        >
                          Модель
                        </th>
                        <th
                          style={{
                            textAlign: "center",
                            padding: "6px 4px",
                            borderBottom: "1px solid rgba(255,255,255,0.12)",
                            width: 90,
                          }}
                        >
                          tool_calls
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {models.map((m) => {
                        const rec = toolCallsSupport?.[m];
                        const mark = rec
                          ? rec.supports_tool_calls
                            ? "✅"
                            : "❌"
                          : "—";
                        return (
                          <tr key={m}>
                            <td
                              style={{
                                padding: "6px 4px",
                                borderBottom: "1px solid rgba(255,255,255,0.08)",
                              }}
                            >
                              <span className="mono">{m}</span>
                            </td>
                            <td
                              style={{
                                textAlign: "center",
                                padding: "6px 4px",
                                borderBottom: "1px solid rgba(255,255,255,0.08)",
                              }}
                            >
                              {mark}
                            </td>
                          </tr>
                        );
                      })}

                      {models.length === 0 ? (
                        <tr>
                          <td className="hint" style={{ padding: "6px 4px" }} colSpan={2}>
                            Модели не найдены.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>

                <div className="hint" style={{ marginTop: 8 }}>
                  “—” заполняется по мере проверок. Также можно просто выбрать модель
                  и нажать “Сохранить выбор” — мы один раз проверим и сохраним.
                </div>
              </div>
            </PanelShell>
          );
        }

        if (id === "journal") {
          return (
            <PanelShell key={id} onClose={() => closePanel(id)}>
              <div className="sidebar__section">
                <div className="sidebar__section-title">Execution Journal</div>

                <div className="hint" style={{ marginBottom: 8 }}>
                  Клик по событию → центрируем граф (пока условно на{" "}
                  <span className="mono">agent/tools</span>).
                </div>

                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 14,
                    background: "rgba(0,0,0,0.10)",
                    maxHeight: 520,
                    overflow: "auto",
                    padding: 8,
                    display: "grid",
                    gap: 6,
                  }}
                >
                  {journalEvents.length === 0 ? (
                    <div className="hint">Пока пусто — запусти Run.</div>
                  ) : (
                    journalEvents.map((ev) => {
                      const active =
                        ev.focusNodeId &&
                        String(ev.focusNodeId) === String(focusNodeId);
                      return (
                        <button
                          key={ev.id}
                          type="button"
                          className="secondary-btn"
                          onClick={() =>
                            ev.focusNodeId && setFocusNodeId(String(ev.focusNodeId))
                          }
                          style={{
                            textAlign: "left",
                            justifyContent: "flex-start",
                            gap: 8,
                            background: active
                              ? "rgba(185,200,230,0.10)"
                              : undefined,
                            borderColor: active
                              ? "rgba(185,200,230,0.28)"
                              : undefined,
                          }}
                        >
                          <span className="mono" style={{ opacity: 0.85 }}>
                            {ev.kind === "tool_call" ? "tool" : ev.role}
                          </span>
                          <span className="mono" style={{ opacity: 0.95 }}>
                            {ev.label}
                          </span>
                          <span
                            className="mono"
                            style={{ marginLeft: "auto", opacity: 0.65 }}
                          >
                            {ev.focusNodeId || "—"}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </PanelShell>
          );
        }

        if (id === "tools") {
          return (
            <PanelShell key={id} onClose={() => closePanel(id)}>
              <div className="sidebar__section">
                <div className="sidebar__section-title">План</div>
                <div className="hint">Здесь позже будут реальные tools (fs/shell/web).</div>
              </div>
            </PanelShell>
          );
        }

        if (id === "cloud_models") {
          return (
            <PanelShell
              key={id}
              onClose={() => closePanel(id)}
            >
              <div className="sidebar__section">
                <div className="sidebar__section-title">План</div>
                <div className="hint">
                  Облачные провайдеры будем делать в <b>другом venv</b>.
                </div>
              </div>
              <div className="placeholder">Скоро.</div>
            </PanelShell>
          );
        }

        return null;
      })}
      {debugOpen ? (
        <PanelShell key="debugger" onClose={() => setDebugOpen(false)}>
          <div className="sidebar__section">
            <div className="sidebar__section-title">Отладчик</div>
            <div className="hint">
              Открытие: кнопка <b>Debug</b> или <b>Alt+Ctrl+E</b>.
              <br />
              Здесь собраны данные для диагностики (ошибки/снапшоты/сеть/модели/инструменты).
            </div>
          </div>

          <div className="sidebar__section">
              <div className="sidebar__section-title">Bootstrap (Level 0)</div>
              <div className="hint">Аварийный слой до React: что произошло, если UI падал на старте.</div>

              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", position: "relative", zIndex: 1, paddingBottom: 8 }}>
                <TipBtn
                  label="Обновить snapshot Level 0"
                  tip={"Обновить snapshot Level 0\n(сборщик ошибок/событий)\nдля отображения в панели."}
                  onClick={() => {
                    refreshDbg0Snap();
                    setDbgRefreshOk(true);
                    window.setTimeout(() => setDbgRefreshOk(false), 700);
                  }}
                  style={
                    dbgRefreshOk ? { boxShadow: "0 0 0 2px rgba(255,255,255,0.25)" } : undefined
                  }
                >
                  {dbgRefreshOk ? "Refreshed" : "Refresh"}
                </TipBtn>

                <TipBtn
                  label="Скопировать snapshot Level 0"
                  tip={"Скопировать текущий snapshot Level 0\n(как есть) в буфер обмена."}
                  onClick={async () => {
                    try {
                      const txt = JSON.stringify(dbg0Snap ?? { empty: true }, null, 2);
                      await navigator.clipboard.writeText(txt);
                      setDbgCopyOk(true);
                      window.setTimeout(() => setDbgCopyOk(false), 900);
                    } catch {}
                  }}
                  style={dbgCopyOk ? { boxShadow: "0 0 0 2px rgba(255,255,255,0.25)" } : undefined}
                >
                  {dbgCopyOk ? "Copied!" : "Copy L0"}
                </TipBtn>

                <TipBtn
                  label="Скопировать Debug Bundle"
                  tip={"Скопировать Debug Bundle из Level 0:\nпоследние ошибки/события/сеть/снапшоты."}
                  onClick={async () => {
                    try {
                      const snap = window.__DBG0__?.snapshot?.({
                        errors: 50,
                        events: 50,
                        network: 50,
                        snapshots: 50,
                      });
                      const txt = JSON.stringify(snap ?? { empty: true }, null, 2);
                      await navigator.clipboard.writeText(txt);
                      setDbgBundleOk(true);
                      window.setTimeout(() => setDbgBundleOk(false), 900);
                    } catch {}
                  }}
                  style={dbgBundleOk ? { boxShadow: "0 0 0 2px rgba(255,255,255,0.25)" } : undefined}
                >
                  {dbgBundleOk ? "Copied!" : "Copy bundle"}
                </TipBtn>

                <TipBtn
                  label="Очистить ошибки Level 0"
                  tip={"Очистить только ошибки Level 0.\nСборщик продолжит работать."}
                  onClick={() => {
                    try {
                      window.__DBG0__?.clearErrors?.();
                    } catch {}
                    refreshDbg0Snap();
                    setDbgClearOk(true);
                    window.setTimeout(() => setDbgClearOk(false), 700);
                  }}
                  style={dbgClearOk ? { boxShadow: "0 0 0 2px rgba(255,255,255,0.25)" } : undefined}
                >
                  {dbgClearOk ? "Cleared" : "Clear errors"}
                </TipBtn>

              </div>

              <div style={{ marginTop: 10 }}>
                {!dbg0Snap ? (
                  <div className="hint">Level 0 snapshot: нет данных (или ещё не было ошибок).</div>
                ) : (
                  <div>
                    <div className="hint">
                      Events: <b>{Array.isArray(dbg0Snap?.events) ? dbg0Snap.events.length : 0}</b>
                    </div>
                    <div className="hint">
                      Errors: <b>{Array.isArray(dbg0Snap?.errors) ? dbg0Snap.errors.length : 0}</b>
                    </div>
                    <div className="hint">
                      Last error: <b>{dbg0Snap?.lastError?.message || "—"}</b>
                    </div>
                    <div className="hint">
                      Kind: <b>{dbg0Snap?.lastError?.kind || "—"}</b>
                    </div>
                    <pre style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>
                      {JSON.stringify(dbg0Snap?.lastError || {}, null, 2)}
                    </pre>

                      <div className="sidebar__section" style={{ marginTop: 14 }}>
                        <div className="sidebar__section-title">Errors (Level 0)</div>
                        <div className="hint">
                          Последние ошибки, пойманные сборщиком Level 0. Формат: что случилось → где → почему.
                        </div>

                        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                          {Array.isArray(dbg0Snap?.errors) && dbg0Snap.errors.length ? (
                            dbg0Snap.errors
                              .slice(-10)
                              .reverse()
                              .map((e) => {
                                const loc = e?.location || {};
                                const file = String(loc?.file || "");
                                const line = loc?.line ? String(loc.line) : "";
                                const col = loc?.col ? String(loc.col) : "";
                                const where = file
                                  ? `${file}${line ? ":" + line : ""}${col ? ":" + col : ""}`
                                  : "—";

                                const causes = Array.isArray(e?.causes) ? e.causes : [];
                                const why =
                                  causes && causes.length
                                    ? String(causes[0]?.message || "") || "—"
                                    : "—";

                                const cnt = e?.dedupe?.count ? Number(e.dedupe.count) : 0;

                                return (
                                  <div
                                    key={String(e?.id || Math.random())}
                                    style={{
                                      border: "1px solid rgba(255,255,255,0.12)",
                                      borderRadius: 14,
                                      background: "rgba(0,0,0,0.10)",
                                      padding: "10px 10px",
                                      display: "grid",
                                      gap: 6,
                                    }}
                                  >
                                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                      <span className="mono" style={{ opacity: 0.85 }}>
                                        {String(e?.scope || "ui")}
                                      </span>
                                      <span className="mono" style={{ opacity: 0.85 }}>
                                        {String(e?.severity || "error")}
                                      </span>
                                      {cnt > 1 ? (
                                        <span className="mono" style={{ marginLeft: "auto", opacity: 0.75 }}>
                                          ×{cnt}
                                        </span>
                                      ) : (
                                        <span style={{ marginLeft: "auto" }} />
                                      )}
                                      <TipBtn
                                        label="Скопировать ошибку"
                                        tip={"Скопировать эту ошибку целиком (JSON) в буфер обмена."}
                                        onClick={async () => {
                                          try {
                                            await navigator.clipboard.writeText(JSON.stringify(e || {}, null, 2));
                                          } catch {}
                                        }}
                                      >
                                        Copy
                                      </TipBtn>
                                    </div>

                                    <div style={{ fontWeight: 700 }}>
                                      {String(e?.message || e?.title || "—")}
                                    </div>

                                    <div className="hint">
                                      <b>Где:</b> <span className="mono">{where}</span>
                                    </div>

                                    <div className="hint">
                                      <b>Почему:</b> {why}
                                    </div>

                                    {Array.isArray(e?.causes) && e.causes.length > 1 ? (
                                      <details>
                                        <summary className="hint" style={{ cursor: "pointer" }}>
                                          Показать цепочку причин ({e.causes.length})
                                        </summary>
                                        <pre style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                                          {JSON.stringify(e.causes, null, 2)}
                                        </pre>
                                      </details>
                                    ) : null}
                                  </div>
                                );
                              })
                          ) : (
                            <div className="hint">Ошибок пока нет.</div>
                          )}
                        </div>
                      </div>

                  </div>
                )}
              </div>
            </div>
          </PanelShell>
      ) : null}

    </div>
  );

  return (
    <div className="app">
      {rail}
      {drawers}

      <div className="main">
        <div className="topbar">
          <div className="tabs">
            {tabs.map((t) => (
              <TabButton
                key={t.id}
                active={tab === t.id}
                onClick={() => {
                  if (t.id === "run") {
                    if (tab === "run") {
                      setSplitMode((m) => (m === "split" ? "run" : "split"));
                    } else {
                      setTab("run");
                    }
                    return;
                  }
                  setTab(t.id);
                }}
              >
                {t.title}
              </TabButton>
            ))}
          </div>

          <div className="topbar__spacer" />
          <a className="ghost-link" href="/api/docs" target="_blank" rel="noreferrer">
            API Docs
          </a>
        </div>

        <div className="content" data-tab={tab}>
          {tab === "run" && (
            <SplitView
              mode={splitMode}
              onModeChange={setSplitMode}
              storageKey="splitview:left_pct"
              left={
                <div className="card">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      marginBottom: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <IconBtn
                        label="Запуск"
                        onClick={runStream}
                        disabled={runRunning || !runInput.trim()}
                      >
                        ▶
                      </IconBtn>
                      <IconBtn label="Остановить" onClick={stopRun} disabled={!runRunning}>
                        ■
                      </IconBtn>
                      <IconBtn label="Очистить" onClick={clearRun} disabled={runRunning}>
                        ⟲
                      </IconBtn>
                    </div>

                    <div
                      className="mono"
                      style={{ opacity: 0.85, fontSize: 12, lineHeight: 1.2 }}
                    >
                      run_id: {runRunId || "-"} · messages: {runSteps.length}
                    </div>
                  </div>

                  <textarea
                    className="select"
                    style={{ height: 110, paddingTop: 10, paddingBottom: 10 }}
                    value={runInput}
                    onChange={(e) => setRunInput(e.target.value)}
                    placeholder="Введите запрос…"
                  />

                  {runStreamError ? <div className="error">{runStreamError}</div> : null}
                  {apiError ? <div className="error">{apiError}</div> : null}

                  {runSteps.length === 0 ? (
                    <div className="placeholder">
                      Нажми ▶ — появятся шаги model/tools и результаты tools.
                    </div>
                  ) : (
                    <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                      {runSteps.map((m, idx) => {
                        const role = msgRoleLabel(m);
                        const tone =
                          role === "model"
                            ? "good"
                            : role === "tool"
                            ? "neutral"
                            : role === "user"
                            ? "neutral"
                            : "neutral";

                        const content = m?.content ?? "";
                        const contentStr =
                          typeof content === "string" ? content : prettyJson(content);
                        const maybeJson =
                          typeof content === "string"
                            ? safeJsonParse(content)
                            : { ok: false };

                        const toolCalls = Array.isArray(m?.tool_calls) ? m.tool_calls : [];
                        const invalidToolCalls = Array.isArray(m?.invalid_tool_calls)
                          ? m.invalid_tool_calls
                          : [];

                        return (
                          <div
                            key={m?.id || `${idx}`}
                            style={{
                              border: "1px solid rgba(255,255,255,0.12)",
                              borderRadius: 14,
                              padding: 10,
                              background: "rgba(255,255,255,0.03)",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                gap: 10,
                                alignItems: "center",
                                flexWrap: "wrap",
                              }}
                            >
                              <Badge tone={tone}>{role}</Badge>
                              <span className="mono" style={{ opacity: 0.85 }}>
                                #{idx + 1}
                              </span>
                              {m?.name ? (
                                <span className="mono" style={{ opacity: 0.85 }}>
                                  name={m.name}
                                </span>
                              ) : null}
                              {m?.response_metadata?.model ? (
                                <span className="mono" style={{ opacity: 0.85 }}>
                                  model={m.response_metadata.model}
                                </span>
                              ) : null}
                              {toolCalls.length ? (
                                <span className="mono" style={{ opacity: 0.85 }}>
                                  tool_calls={toolCalls.length}
                                </span>
                              ) : null}
                              {invalidToolCalls.length ? (
                                <span className="mono" style={{ opacity: 0.85 }}>
                                  invalid_tool_calls={invalidToolCalls.length}
                                </span>
                              ) : null}
                            </div>

                            {contentStr ? (
                              <pre
                                className="mono"
                                style={{
                                  marginTop: 8,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                  padding: 10,
                                  borderRadius: 12,
                                  background: "rgba(0,0,0,0.18)",
                                  border: "1px solid rgba(255,255,255,0.10)",
                                  maxHeight: 260,
                                  overflow: "auto",
                                }}
                              >
                                {contentStr}
                              </pre>
                            ) : null}

                            {toolCalls.length ? (
                              <pre
                                className="mono"
                                style={{
                                  marginTop: 8,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                  padding: 10,
                                  borderRadius: 12,
                                  background: "rgba(0,0,0,0.14)",
                                  border: "1px solid rgba(255,255,255,0.10)",
                                  maxHeight: 240,
                                  overflow: "auto",
                                }}
                              >
                                {prettyJson({ tool_calls: toolCalls })}
                              </pre>
                            ) : null}

                            {invalidToolCalls.length ? (
                              <pre
                                className="mono"
                                style={{
                                  marginTop: 8,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                  padding: 10,
                                  borderRadius: 12,
                                  background: "rgba(255,90,90,0.08)",
                                  border: "1px solid rgba(255,90,90,0.18)",
                                  maxHeight: 240,
                                  overflow: "auto",
                                }}
                              >
                                {prettyJson({ invalid_tool_calls: invalidToolCalls })}
                              </pre>
                            ) : null}

                            {maybeJson.ok ? (
                              <div className="hint" style={{ marginTop: 6 }}>
                                content выглядит как JSON (возможно псевдо-toolcall, если модель не поддерживает tool_calls).
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              }
              right={
                <div className="graph-host">
                  <GraphView
                    assistantId={assistantId}
                    focusNodeId={focusNodeId}
                    onNodeSelected={setFocusNodeId}
                  />
                </div>
              }
            />
          )}

          {tab === "graph" && (
            <div className="graph-host">
              <GraphView
                assistantId={assistantId}
                focusNodeId={focusNodeId}
                onNodeSelected={setFocusNodeId}
              />
            </div>
          )}

          {tab === "history" && (
            <div className="card">
              <h2>History</h2>
              <p className="muted">История runs/threads + повтор запуска.</p>
              <div className="placeholder">Скоро: список runs.</div>
            </div>
          )}

          {tab === "state" && (
            <div className="card">
              <h2>State</h2>
              <p className="muted">Просмотр state и diff (до/после) по шагам.</p>
              <div className="placeholder">Скоро: state viewer + diff.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
