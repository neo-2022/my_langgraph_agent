import { useMemo, useState } from "react";
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

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tab, setTab] = useState("run");

  const tabs = useMemo(
    () => [
      { id: "run", title: "Run" },
      { id: "graph", title: "Graph" },
      { id: "history", title: "History" },
      { id: "state", title: "State" },
    ],
    []
  );

  return (
    <div className="shell">
      {/* Sidebar */}
      <aside className={`sidebar ${sidebarOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar__header">
          <div className="brand">
            <div className="brand__logo">⛓️</div>
            <div className="brand__text">
              <div className="brand__title">my_langgraph_agent</div>
              <div className="brand__subtitle">Local UI</div>
            </div>
          </div>

          <button
            className="icon-btn"
            type="button"
            onClick={() => setSidebarOpen(false)}
            title="Свернуть панель"
          >
            ◀
          </button>
        </div>

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
            <div className="kv__k">Settings UI</div>
            <div className="kv__v">
              <a href="http://127.0.0.1:8088" target="_blank" rel="noreferrer">
                127.0.0.1:8088
              </a>
              <Badge tone="good">ON</Badge>
            </div>
          </div>
        </div>

        <div className="sidebar__section">
          <div className="sidebar__section-title">Быстрые действия</div>
          <button className="primary-btn" type="button" disabled>
            Сохранить выбор модели (скоро)
          </button>
          <button className="secondary-btn" type="button" disabled>
            Перезапустить LangGraph (скоро)
          </button>
          <div className="hint">
            Сейчас это каркас. Дальше мы перенесём сюда настройки из Settings UI и
            подключим API.
          </div>
        </div>

        <div className="sidebar__footer">
          <div className="hint">
            Панель будет выдвижной. Основная работа — во вкладках справа.
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="main">
        <div className="topbar">
          {!sidebarOpen && (
            <button
              className="icon-btn"
              type="button"
              onClick={() => setSidebarOpen(true)}
              title="Открыть панель"
            >
              ▶
            </button>
          )}

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

          <a
            className="ghost-link"
            href="http://127.0.0.1:2024/docs"
            target="_blank"
            rel="noreferrer"
          >
            API Docs
          </a>
        </div>

        <div className="content">
          {tab === "run" && (
            <div className="card">
              <h2>Run</h2>
              <p className="muted">
                Здесь будет чат + запуск runs/stream и отображение tool calls.
              </p>
              <div className="placeholder">Скоро: поле ввода, кнопка “Запуск”, вывод.</div>
            </div>
          )}

          {tab === "graph" && (
            <div className="card">
              <h2>Graph</h2>
              <p className="muted">
                Здесь будет визуализация графа (React Flow) + автолэйаут.
              </p>
              <div className="placeholder">Скоро: nodes/edges + layout.</div>
            </div>
          )}

          {tab === "history" && (
            <div className="card">
              <h2>History</h2>
              <p className="muted">
                Здесь будет история runs/threads + повтор запуска.
              </p>
              <div className="placeholder">Скоро: список runs.</div>
            </div>
          )}

          {tab === "state" && (
            <div className="card">
              <h2>State</h2>
              <p className="muted">
                Здесь будет просмотр state и diff (до/после) по шагам.
              </p>
              <div className="placeholder">Скоро: state viewer + diff.</div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}