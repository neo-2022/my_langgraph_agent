import { useEffect, useMemo, useState } from "react";
import "./App.css";

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

export default function App() {
  // Основные вкладки (центр)
  const [tab, setTab] = useState("run");

  // Выезжающие панели: можно открыть несколько
  // порядок = порядок “стопки” слева направо
  const [openPanels, setOpenPanels] = useState(["general"]);

  // General / API
  const [apiStatus, setApiStatus] = useState("не проверял");
  const [apiError, setApiError] = useState("");

  // Run ping demo
  const [runAnswer, setRunAnswer] = useState("");
  const [runModel, setRunModel] = useState("");

  // Локальные модели (Ollama) через ui_proxy (/ui/*)
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
    setOpenPanels((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  };

  const closePanel = (id) => {
    setOpenPanels((prev) => prev.filter((x) => x !== id));
  };

  // -------- General/API actions --------
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

  // -------- Local models actions --------
  const loadModels = async () => {
    setSaveError("");
    setSaveInfo("");
    setModelsLoading(true);
    try {
      const data = await getJson("/ui/models");
      setModels(Array.isArray(data.models) ? data.models : []);
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

  // -------- Run demo --------
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

  // автозагрузка моделей при старте (один раз)
  useEffect(() => {
    loadModels();
  }, []);

  // Рельса слева (ярлычки)
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

  // Панели (drawers), открытые слева направо
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

                <label className="label">
                  Текущая модель
                  <select
                    className="select"
                    value={currentModel}
                    onChange={(e) => setCurrentModel(e.target.value)}
                    disabled={modelsLoading || models.length === 0}
                  >
                    {models.length === 0 ? (
                      <option value="">(модели не найдены)</option>
                    ) : (
                      models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))
                    )}
                  </select>
                </label>

                <button className="primary-btn" type="button" onClick={saveModel}>
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
                  Здесь появятся инструменты: файловая система, shell, веб-поиск (позже), и управление ими.
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

      {/* Основная часть */}
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

          {tab === "graph" && (
            <div className="card">
              <h2>Graph</h2>
              <p className="muted">Тут будет визуализация графа (React Flow) + автолэйаут.</p>
              <div className="placeholder">Скоро: nodes/edges + layout.</div>
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
