import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import "./App.css";
import "reactflow/dist/style.css";
import GraphView from "./GraphView.jsx";

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
 * - есть hover-цвета, скролл, нормальные радиусы
 */
function FancySelect({
  label,
  value,
  options,
  onChange,
  disabled,
  placeholder = "—",
  tip, // строка для tooltip в заголовке (например "Раскладка (Layout)")
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0, width: 260, dir: "down" });

  const selected = options.find((o) => String(o.value) === String(value)) || null;

  const close = useCallback(() => setOpen(false), []);

  const computePos = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = r.width;
    const maxH = 320;
    const spaceBelow = window.innerHeight - r.bottom - 12;
    const spaceAbove = r.top - 12;

    const dir = spaceBelow >= Math.min(maxH, 220) ? "down" : spaceAbove > spaceBelow ? "up" : "down";
    const top = dir === "down" ? r.bottom + 6 : Math.max(12, r.top - 6 - Math.min(maxH, 300));
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
              <div className="fselect__item fselect__item--disabled">{placeholder}</div>
            ) : (
              options.map((o) => {
                const isActive = String(o.value) === String(value);
                return (
                  <button
                    key={String(o.value)}
                    type="button"
                    className={`fselect__item ${isActive ? "fselect__item--active" : ""}`}
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
        {tip ? <span className="label__tip" title={tip}>{tip}</span> : null}
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
          {selected ? selected.label : <span className="fselect__placeholder">{placeholder}</span>}
        </span>
        <span className="fselect__chev" aria-hidden="true">▾</span>
      </button>

      {menu}
    </label>
  );
}

export default function App() {
  const [tab, setTab] = useState("run");
  const [openPanels, setOpenPanels] = useState(["general"]);

  const [apiStatus, setApiStatus] = useState("не проверял");
  const [apiError, setApiError] = useState("");

  const [assistantId, setAssistantId] = useState("");
  const [assistantName, setAssistantName] = useState("");
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [assistantErr, setAssistantErr] = useState("");
  const [assistantInfo, setAssistantInfo] = useState("");

  const [runAnswer, setRunAnswer] = useState("");
  const [runModel, setRunModel] = useState("");

  const [modelsLoading, setModelsLoading] = useState(false);
  const [models, setModels] = useState([]);
  const [currentModel, setCurrentModel] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [saveInfo, setSaveInfo] = useState("");
  const [saveError, setSaveError] = useState("");

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
      { id: "cloud_models", title: "Облачные модели" },
      { id: "tools", title: "Инструменты" },
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
      await postJson("/ui/model", { model: currentModel });
      setSaveInfo(
        "Готово. Теперь: 1) нажми «Перезапустить LangGraph сервер»  2) обнови страницу  3) сделай Ping."
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
      setSaveInfo("LangGraph перезапущен. Обнови страницу и сделай Ping.");
    } catch (e) {
      setSaveError(String(e?.message || e));
    }
  };

  const runPing = async () => {
    setApiError("");
    setRunAnswer("");
    setRunModel("");
    try {
      const assistants = await postJson("/api/assistants/search", {});
      const a = Array.isArray(assistants) ? assistants[0] : null;
      if (!a?.assistant_id) {
        throw new Error("Не найден assistant_id. Проверь, что LangGraph сервер запущен.");
      }

      // обновим локально выбранный assistant, чтобы Graph тоже работал сразу
      setAssistantId(a.assistant_id);
      setAssistantName(a.name || "");

      const out = await postJson("/api/runs/wait", {
        assistant_id: a.assistant_id,
        input: { messages: [{ role: "user", content: "Скажи одним словом: ping" }] },
      });

      const msgs = out?.messages || [];
      const last = msgs[msgs.length - 1] || {};
      const meta = last?.response_metadata || {};
      const model = meta.model || meta.model_name || "";

      setRunAnswer(last?.content || "(пусто)");
      setRunModel(model || "(неизвестно)");
    } catch (e) {
      setApiError(String(e?.message || e));
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
                    <a href="http://127.0.0.1:2024/docs" target="_blank" rel="noreferrer">
                      127.0.0.1:2024
                    </a>
                    <Badge tone="good">ON</Badge>
                  </div>
                </div>

                <div className="kv">
                  <div className="kv__k">UI Proxy</div>
                  <div className="kv__v">
                    <a href="http://127.0.0.1:8090/health" target="_blank" rel="noreferrer">
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
                {assistantErr ? <div className="error">{assistantErr}</div> : null}
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
                  <a className="ghost-link" href="/api/docs" target="_blank" rel="noreferrer">
                    API Docs (через /api)
                  </a>
                </div>
              </div>
            </PanelShell>
          );
        }

        if (id === "local_models") {
          const modelOptions = models.map((m) => ({ value: m, label: m, title: m }));

          return (
            <PanelShell key={id} title="Локальные модели (Ollama)" onClose={() => closePanel(id)}>
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
                  placeholder={models.length === 0 ? "(модели не найдены)" : "Выбери модель"}
                />

                <button className="primary-btn" type="button" onClick={saveModel} style={{ marginTop: 10 }}>
                  Сохранить выбор
                </button>

                <button className="secondary-btn" type="button" onClick={restartLanggraph}>
                  Перезапустить LangGraph сервер
                </button>

                {saveInfo ? <div className="ok">{saveInfo}</div> : null}
                {saveError ? <div className="error">{saveError}</div> : null}

                <div className="hint">
                  Порядок действий: выбери модель → <b>Сохранить выбор</b> →{" "}
                  <b>Перезапустить LangGraph сервер</b> → обнови страницу.
                </div>
              </div>

              <div className="sidebar__section">
                <div className="sidebar__section-title">Дальше</div>
                <div className="hint">
                  Здесь добавим: поддержка <span className="mono">tool_calls</span> (probe),
                  скорость/токены, “рекомендовать модель под задачу”.
                </div>
              </div>
            </PanelShell>
          );
        }

        if (id === "cloud_models") {
          return (
            <PanelShell key={id} title="Облачные модели" onClose={() => closePanel(id)}>
              <div className="sidebar__section">
                <div className="sidebar__section-title">План</div>
                <div className="hint">
                  Облачные провайдеры будем делать в <b>другом venv</b>, чтобы не ловить конфликты
                  зависимостей. Здесь будет выбор провайдера (OpenAI/Anthropic/и т.д.), ключи, и
                  переключение.
                </div>
              </div>
              <div className="placeholder">Скоро.</div>
            </PanelShell>
          );
        }

        if (id === "tools") {
          return (
            <PanelShell key={id} title="Инструменты" onClose={() => closePanel(id)}>
              <div className="sidebar__section">
                <div className="sidebar__section-title">План</div>
                <div className="hint">
                  Здесь появятся инструменты: файловая система, shell, веб-поиск (позже), и управление
                  ими.
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
              <TabButton key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
                {t.title}
              </TabButton>
            ))}
          </div>

          <div className="topbar__spacer" />

          <a className="ghost-link" href="/api/docs" target="_blank" rel="noreferrer">
            API Docs
          </a>
        </div>

        <div className="content">
          {tab === "run" && (
            <div className="card">
              <h2>Run</h2>
              <p className="muted">Тест: UI → Proxy → LangGraph → Ollama.</p>

              <button className="primary-btn" type="button" onClick={runPing}>
                Ping через runs/wait
              </button>

              {runAnswer ? (
                <div className="result">
                  <div className="result__row">
                    <div className="result__k">Модель</div>
                    <div className="result__v mono">{runModel}</div>
                  </div>
                  <div className="result__row">
                    <div className="result__k">Ответ</div>
                    <div className="result__v mono">{runAnswer}</div>
                  </div>
                </div>
              ) : (
                <div className="placeholder">Нажми Ping — увидишь модель и ответ.</div>
              )}

              {apiError ? <div className="error">{apiError}</div> : null}
            </div>
          )}

          {tab === "graph" && <GraphView assistantId={assistantId} />}

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
