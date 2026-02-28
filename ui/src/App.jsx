import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import "./App.css";
import "reactflow/dist/style.css";
import GraphView from "./GraphView.jsx";
import SplitView from "./SplitView.jsx";

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`tab-btn ${active ? "tab-btn--active" : ""}`}
      type="button"
    >
      {children}
    </button>
  );
}

function Badge({ children, tone = "neutral" }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

function IconBtn({ title, onClick, children }) {
  return (
    <button className="icon-btn" type="button" title={title} onClick={onClick}>
      {children}
    </button>
  );
}

function RailButton({ active, onClick, children, title }) {
  return (
    <button
      type="button"
      className={`rail-btn ${active ? "rail-btn--active" : ""}`}
      onClick={onClick}
      title={title}
    >
      <span className="rail-btn__text">{children}</span>
    </button>
  );
}

async function getJson(path) {
  const r = await fetch(path);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${txt || "ошибка"}`);
  }
  return await r.json();
}

async function postJson(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${txt || "ошибка"}`);
  }
  return await r.json();
}

function PanelShell({ title, onClose, children }) {
  return (
    <section className="drawer">
      <div className="drawer__header">
        <div className="drawer__title">{title}</div>
        <IconBtn title="Закрыть" onClick={onClose}>
          ✕
        </IconBtn>
      </div>
      <div className="drawer__body">{children}</div>
    </section>
  );
}

/**
 * Кастомный select (чтобы реально стилизовать выпадающий список и не обрезалось).
 * - меню рисуем порталом в document.body (position: fixed)
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
                    title={o.title || ""}
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
        {tip ? (
          <span className="label__tip" title={tip}>
            {tip}
          </span>
        ) : null}
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
  const [splitMode, setSplitMode] = useState(() => {
    try {
      return localStorage.getItem("splitview:mode") || "split";
    } catch {
      return "split";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("splitview:mode", splitMode);
    } catch {}
  }, [splitMode]);
  const [focusNodeId, setFocusNodeId] = useState("");
  const [openPanels, setOpenPanels] = useState(["general"]);

  const [apiStatus, setApiStatus] = useState("не проверял");
  const [apiError, setApiError] = useState("");

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

  // probe tool_calls
  const [probeLoading, setProbeLoading] = useState(false);
  const [probeMaxModels, setProbeMaxModels] = useState(8);
  const [probeRows, setProbeRows] = useState([]); // [{model, ok, cached, tool_calls_count, error}]
  const [probeInfo, setProbeInfo] = useState("");
  const [probeError, setProbeError] = useState("");

  // Run tab (stream)
  const [runInput, setRunInput] = useState("Сложение: 2+2=? Просто ответ.");
  const [runRunning, setRunRunning] = useState(false);
  const [runRunId, setRunRunId] = useState("");
  const [runSteps, setRunSteps] = useState([]); // array of messages
  const [runStreamError, setRunStreamError] = useState("");
  const abortRef = useRef(null);
  const seenCountRef = useRef(0);

  // Execution Journal (MVP): временно строим из messages/tool_calls.
  // Синхронизация: клик по событию -> центрируем граф на условной ноде (agent/tools).
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
      { id: "general", title: "Общее" },
      { id: "local_models", title: "Локальные модели" },
      { id: "tools", title: "Инструменты" },
      { id: "cloud_models", title: "Облачные модели" },
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
    setProbeError("");
    setProbeInfo("");
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
      setCurrentModel(String(data.current || ""));
      setDefaultModel(String(data.default || ""));
    } catch (e) {
      setSaveError(String(e?.message || e));
    } finally {
      setModelsLoading(false);
    }
  };

  const saveModel = async () => {
    setSaveError("");
    setSaveInfo("");
    try {
      const out = await postJson("/ui/model", { model: currentModel });
      if (!out?.ok) throw new Error(out?.error || "Не удалось сохранить модель");
      setSaveInfo(
        "Готово. Теперь: 1) нажми «Перезапустить LangGraph сервер»  2) обнови страницу."
      );
    } catch (e) {
      setSaveError(String(e?.message || e));
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
    }
  };

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

      const resp = await fetch("/api/runs/stream", {
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
      } else {
        setRunStreamError(String(e?.message || e));
      }
    } finally {
      setRunRunning(false);
      abortRef.current = null;
    }
  };

  const probeAll = async (force = false) => {
    setProbeError("");
    setProbeInfo("");
    setProbeLoading(true);
    try {
      const data = await getJson("/ui/models");
      const list = Array.isArray(data.models) ? data.models : [];
      if (list.length === 0) {
        setProbeRows([]);
        setProbeInfo("Модели не найдены (ollama list пуст).");
        return;
      }

      const requested = Number(probeMaxModels) || 8;
      const maxN = Math.max(1, Math.min(24, requested, list.length));
      const take = list.slice(0, maxN);

      const rows = [];
      for (const m of take) {
        try {
          const r = await postJson("/ui/probe-tool-calls", {
            model: m,
            force: !!force,
          });
          rows.push({
            model: m,
            ok: !!r.supports_tool_calls,
            cached: !!r.cached,
            tool_calls_count: Number(r.tool_calls_count || 0),
            error: r.error ? String(r.error) : "",
          });
        } catch (e) {
          rows.push({
            model: m,
            ok: false,
            cached: false,
            tool_calls_count: 0,
            error: String(e?.message || e),
          });
        }
      }

      setProbeRows(rows);
      if (list.length > maxN) {
        setProbeInfo(
          `Показаны первые ${maxN}/${list.length}. Увеличь лимит (max) если надо.`
        );
      } else {
        setProbeInfo(`Проверено ${list.length} моделей.`);
      }
    } catch (e) {
      setProbeError(String(e?.message || e));
    } finally {
      setProbeLoading(false);
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
      <div className="rail__logo" title="my_langgraph_agent">
        ⛓️
      </div>

      <div className="rail__group">
        {panelDefs.map((p) => (
          <RailButton
            key={p.id}
            active={isOpen(p.id)}
            onClick={() => togglePanel(p.id)}
            title={p.title}
          >
            {p.title}
          </RailButton>
        ))}
      </div>

      <div className="rail__hint">
        Нажимай ярлычок — панель откроется/закроется. Можно открыть несколько.
      </div>
    </nav>
  );

  const drawers = (
    <div className="drawers">
      {openPanels.map((id) => {
        if (id === "general") {
          return (
            <PanelShell key={id} title="Общее" onClose={() => closePanel(id)}>
              <div className="sidebar__section">
                <div className="sidebar__section-title">Сервисы</div>

                <div className="kv">
                  <div className="kv__k">LangGraph</div>
                  <div className="kv__v">
                    <a
                      href="http://127.0.0.1:2024/docs"
                      target="_blank"
                      rel="noreferrer"
                    >
                      127.0.0.1:2024
                    </a>
                    <Badge tone="good">ON</Badge>
                  </div>
                </div>

                <div className="kv">
                  <div className="kv__k">UI Proxy</div>
                  <div className="kv__v">
                    <a
                      href="http://127.0.0.1:8090/health"
                      target="_blank"
                      rel="noreferrer"
                    >
                      127.0.0.1:8090
                    </a>
                    <Badge tone="good">ON</Badge>
                  </div>
                </div>

                <div className="kv">
                  <div className="kv__k">React UI</div>
                  <div className="kv__v">
                    <span className="mono">127.0.0.1:5174</span>
                    <Badge tone="good">ON</Badge>
                  </div>
                </div>
              </div>

              <div className="sidebar__section">
                <div className="sidebar__section-title">Assistant</div>

                <button
                  className="secondary-btn"
                  type="button"
                  onClick={loadAssistants}
                  disabled={assistantLoading}
                  title="Refresh assistant"
                >
                  {assistantLoading ? "Обновляю…" : "Обновить assistant"}
                </button>

                <div className="hint">
                  ID: <span className="mono">{assistantId || "-"}</span>
                  <br />
                  Name: <span className="mono">{assistantName || "-"}</span>
                </div>

                {assistantInfo ? <div className="ok">{assistantInfo}</div> : null}
                {assistantErr ? (
                  <div className="error">{assistantErr}</div>
                ) : null}
              </div>

              <div className="sidebar__section">
                <div className="sidebar__section-title">API</div>

                <button className="secondary-btn" type="button" onClick={checkApi}>
                  Проверить API
                </button>

                <div className="hint">
                  Статус: <span className="mono">{apiStatus}</span>
                </div>

                {apiError ? <div className="error">{apiError}</div> : null}
              </div>

              <div className="sidebar__section">
                <div className="sidebar__section-title">Ссылки</div>
                <div className="hint">
                  <a
                    className="ghost-link"
                    href="/api/docs"
                    target="_blank"
                    rel="noreferrer"
                  >
                    API Docs (через /api)
                  </a>
                </div>
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

          return (
            <PanelShell
              key={id}
              title="Локальные модели (Ollama)"
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
                  По умолчанию:{" "}
                  <span className="mono">{defaultModel || "-"}</span>
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
            </PanelShell>
          );
        }

        if (id === "tools") {
          return (
            <PanelShell
              key={id}
              title="Инструменты"
              onClose={() => closePanel(id)}
            >
              <div className="sidebar__section">
                <div className="sidebar__section-title">tool_calls (probe)</div>

                <div className="hint">
                  Проверяет, делает ли модель{" "}
                  <span className="mono">реальные tool_calls</span>.
                </div>

                <label className="label">
                  <span className="label__text">
                    max (сколько моделей проверять)
                  </span>
                  <input
                    className="select"
                    type="number"
                    min="1"
                    max="24"
                    value={probeMaxModels}
                    onChange={(e) => setProbeMaxModels(e.target.value)}
                  />
                </label>

                <button
                  className="secondary-btn"
                  type="button"
                  onClick={() => probeAll(false)}
                  disabled={probeLoading}
                >
                  {probeLoading ? "Проверяю…" : "Проверить (кэш)"}
                </button>

                <button
                  className="secondary-btn"
                  type="button"
                  onClick={() => probeAll(true)}
                  disabled={probeLoading}
                >
                  {probeLoading ? "Проверяю…" : "Проверить (force)"}
                </button>

                {probeInfo ? <div className="ok">{probeInfo}</div> : null}
                {probeError ? <div className="error">{probeError}</div> : null}

                {probeRows.length === 0 ? (
                  <div className="placeholder">
                    Нажми “Проверить” — появится таблица.
                  </div>
                ) : (
                  <div style={{ marginTop: 10 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th
                            style={{
                              textAlign: "left",
                              padding: "6px 4px",
                              borderBottom:
                                "1px solid rgba(255,255,255,0.12)",
                            }}
                          >
                            Модель
                          </th>
                          <th
                            style={{
                              textAlign: "center",
                              padding: "6px 4px",
                              borderBottom:
                                "1px solid rgba(255,255,255,0.12)",
                              width: 70,
                            }}
                          >
                            tool_calls
                          </th>
                          <th
                            style={{
                              textAlign: "center",
                              padding: "6px 4px",
                              borderBottom:
                                "1px solid rgba(255,255,255,0.12)",
                              width: 70,
                            }}
                          >
                            кэш
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {probeRows.map((r) => (
                          <tr key={r.model}>
                            <td
                              style={{
                                padding: "6px 4px",
                                borderBottom:
                                  "1px solid rgba(255,255,255,0.08)",
                              }}
                            >
                              <span className="mono">{r.model}</span>
                              {r.error ? (
                                <div className="hint" style={{ marginTop: 4 }}>
                                  err: <span className="mono">{r.error}</span>
                                </div>
                              ) : null}
                            </td>
                            <td
                              style={{
                                textAlign: "center",
                                padding: "6px 4px",
                                borderBottom:
                                  "1px solid rgba(255,255,255,0.08)",
                              }}
                            >
                              {r.ok ? "✅" : "❌"}
                            </td>
                            <td
                              style={{
                                textAlign: "center",
                                padding: "6px 4px",
                                borderBottom:
                                  "1px solid rgba(255,255,255,0.08)",
                              }}
                            >
                              {r.cached ? "✓" : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="sidebar__section">
                <div className="sidebar__section-title">План</div>
                <div className="hint">
                  Здесь позже будут реальные tools (fs/shell/web). Сейчас —
                  минимальный probe.
                </div>
              </div>
            </PanelShell>
          );
        }

        if (id === "cloud_models") {
          return (
            <PanelShell
              key={id}
              title="Облачные модели"
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
                onClick={() => setTab(t.id)}
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

        <div
          className="content"
          style={tab === "graph" ? { paddingRight: 0, paddingBottom: 0 } : undefined}
        >
          {tab === "run" && (
            <SplitView
              mode={splitMode}
              onModeChange={setSplitMode}
              storageKey="splitview:left_pct"
              left={(
            <div className="card">
              <h2>Run</h2>
              <p className="muted">
                Ввод → запуск → поток шагов (messages) из{" "}
                <span className="mono">/runs/stream</span>.
              </p>

              <label className="label">
                <span className="label__text">Ввод</span>
                <textarea
                  className="select"
                  style={{ height: 120, paddingTop: 10, paddingBottom: 10 }}
                  value={runInput}
                  onChange={(e) => setRunInput(e.target.value)}
                  placeholder="Введите запрос…"
                />
              </label>

              <div
                style={{
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                  marginTop: 10,
                }}
              >
                <button
                  className="primary-btn"
                  type="button"
                  onClick={runStream}
                  disabled={runRunning || !runInput.trim()}
                >
                  {runRunning ? "Выполняю…" : "Запуск (stream)"}
                </button>

                <button
                  className="secondary-btn"
                  type="button"
                  onClick={stopRun}
                  disabled={!runRunning}
                >
                  Остановить
                </button>

                <button
                  className="secondary-btn"
                  type="button"
                  onClick={clearRun}
                  disabled={runRunning}
                >
                  Очистить
                </button>
              </div>

              <div className="hint" style={{ marginTop: 10 }}>
                run_id: <span className="mono">{runRunId || "-"}</span>
                <br />
                messages: <span className="mono">{runSteps.length}</span>
              </div>

              {/* Execution Journal (MVP): временно из messages/tool_calls. */}
              <div style={{ marginTop: 10 }}>
                <div
                  className="sidebar__section-title"
                  style={{ marginBottom: 6, opacity: 0.9 }}
                >
                  Execution Journal (MVP)
                </div>

                <div className="hint" style={{ marginBottom: 8 }}>
                  Клик по событию → центрируем граф (пока условно на <span className="mono">agent/tools</span>).
                </div>

                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 14,
                    background: "rgba(0,0,0,0.10)",
                    maxHeight: 220,
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
                      const active = ev.focusNodeId && String(ev.focusNodeId) === String(focusNodeId);
                      return (
                        <button
                          key={ev.id}
                          type="button"
                          className="secondary-btn"
                          onClick={() => ev.focusNodeId && setFocusNodeId(String(ev.focusNodeId))}
                          title={ev.focusNodeId ? `focus: ${ev.focusNodeId}` : ""}
                          style={{
                            textAlign: "left",
                            justifyContent: "flex-start",
                            gap: 8,
                            background: active ? "rgba(185,200,230,0.10)" : undefined,
                            borderColor: active ? "rgba(185,200,230,0.28)" : undefined,
                          }}
                        >
                          <span className="mono" style={{ opacity: 0.85 }}>
                            {ev.kind === "tool_call" ? "tool" : ev.role}
                          </span>
                          <span className="mono" style={{ opacity: 0.95 }}>
                            {ev.label}
                          </span>
                          <span className="mono" style={{ marginLeft: "auto", opacity: 0.65 }}>
                            {ev.focusNodeId || "—"}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {runStreamError ? <div className="error">{runStreamError}</div> : null}
              {apiError ? <div className="error">{apiError}</div> : null}

              {runSteps.length === 0 ? (
                <div className="placeholder">
                  Нажми “Запуск (stream)” — появятся шаги model/tools и результаты tools.
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
              )}
              right={<GraphView assistantId={assistantId} focusNodeId={focusNodeId} onNodeSelected={setFocusNodeId} />}
            />
          )}

          {tab === "graph" && <GraphView assistantId={assistantId} focusNodeId={focusNodeId} onNodeSelected={setFocusNodeId} />}

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
