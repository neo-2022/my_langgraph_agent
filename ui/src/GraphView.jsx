import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useEdgesState,
  useNodesState,
} from "reactflow";
import dagre from "dagre";

const NODE_W = 210;
const NODE_H = 56;

function layoutDagre(nodes, edges, direction = "LR") {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 40, ranksep: 80 });

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  const outNodes = nodes.map((n) => {
    const p = g.node(n.id);
    return {
      ...n,
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
      sourcePosition: direction === "LR" ? "right" : "bottom",
      targetPosition: direction === "LR" ? "left" : "top",
    };
  });

  return { nodes: outNodes, edges };
}

function rfNodeFromApi(n) {
  const label = n?.data?.name || n?.data?.label || n?.id || "(node)";
  const kind = n?.type || "node";
  const isStart = n.id === "__start__";
  const isEnd = n.id === "__end__";

  const className = [
    "lg-node",
    isStart ? "lg-node--start" : "",
    isEnd ? "lg-node--end" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: String(n.id),
    type: "default",
    data: { label: isStart ? "START" : isEnd ? "END" : label, kind },
    position: { x: 0, y: 0 },
    className,
  };
}

function rfEdgeFromApi(e, idx) {
  const id = e?.id ? String(e.id) : `e-${e?.source}-${e?.target}-${idx}`;
  const conditional = Boolean(e?.conditional);
  return {
    id,
    source: String(e.source),
    target: String(e.target),
    animated: conditional,
    label: conditional ? "cond" : "",
    style: conditional ? { strokeDasharray: "6 4" } : undefined,
  };
}

async function getJson(path) {
  const r = await fetch(path);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${txt || "ошибка"}`);
  }
  return await r.json();
}

/**
 * FancySelect: меню рендерится порталом в body,
 * поэтому не обрезается карточками/overflow.
 */
function FancySelect({
  labelRu,
  labelEn,
  value,
  options,
  onChange,
  disabled,
  placeholder = "—",
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0, width: 260 });

  const selected = options.find((o) => String(o.value) === String(value)) || null;

  const close = useCallback(() => setOpen(false), []);

  const computePos = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = r.width;
    const maxH = 320;

    const spaceBelow = window.innerHeight - r.bottom - 10;
    const spaceAbove = r.top - 10;
    const openDown = spaceBelow >= Math.min(maxH, 220) || spaceBelow >= spaceAbove;

    const top = openDown
      ? r.bottom + 4
      : Math.max(10, r.top - 4 - Math.min(maxH, 300));

    setMenuPos({
      left: Math.min(window.innerWidth - 10 - width, Math.max(10, r.left)),
      top,
      width,
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
          style={{ left: menuPos.left, top: menuPos.top, width: menuPos.width }}
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
    <div className="field">
      <div className="field__label" data-en={labelEn} title={labelEn}>
        {labelRu}
      </div>

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
        <span className="fselect__chev" aria-hidden="true">
          ▾
        </span>
      </button>

      {menu}
    </div>
  );
}

export default function GraphView({ assistantId }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [direction, setDirection] = useState("LR"); // LR | TB

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const hasGraph = nodes.length > 0;

  const loadGraph = useCallback(async () => {
    if (!assistantId) return;
    setError("");
    setLoading(true);
    try {
      const data = await getJson(`/api/assistants/${assistantId}/graph`);
      const apiNodes = Array.isArray(data?.nodes) ? data.nodes : [];
      const apiEdges = Array.isArray(data?.edges) ? data.edges : [];

      const rfNodes = apiNodes.map(rfNodeFromApi);
      const rfEdges = apiEdges.map(rfEdgeFromApi);

      const laid = layoutDagre(rfNodes, rfEdges, direction);
      setNodes(laid.nodes);
      setEdges(laid.edges);
    } catch (e) {
      setError(String(e?.message || e));
      setNodes([]);
      setEdges([]);
    } finally {
      setLoading(false);
    }
  }, [assistantId, direction, setNodes, setEdges]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  const hint = useMemo(() => {
    if (!assistantId) return "Нет assistant_id. Открой Run и убедись, что /api доступен.";
    if (loading) return "Загружаю граф…";
    if (error) return "Ошибка загрузки графа.";
    if (!hasGraph) return "Граф пустой.";
    return "";
  }, [assistantId, loading, error, hasGraph]);

  // Tooltips RU+EN для кнопок Controls (без attributes — чтобы не зациклить браузер)
  const hostRef = useRef(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const mapRuEn = {
      "zoom in": "Приблизить (Zoom in)",
      "zoom out": "Отдалить (Zoom out)",
      "fit view": "Вписать в экран (Fit view)",
      "toggle interactivity": "Интерактивность (Toggle interactivity)",
    };

    const apply = () => {
      const buttons = host.querySelectorAll(".react-flow__controls button");
      buttons.forEach((b) => {
        const aria = (b.getAttribute("aria-label") || "").trim();
        if (!aria) return;
        const tip = mapRuEn[aria] || aria;
        b.setAttribute("data-tip", tip);
      });
    };

    apply();
    const mo = new MutationObserver(() => apply());
    mo.observe(host, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  const directionOptions = useMemo(
    () => [
      { value: "LR", label: "Left → Right", title: "Left → Right" },
      { value: "TB", label: "Top → Bottom", title: "Top → Bottom" },
    ],
    []
  );

  return (
    <div ref={hostRef} style={{ display: "grid", gap: 10 }}>
      <div className="card" style={{ maxWidth: "none" }}>
        <div className="graphbar">
          <div className="lg-brand">LangGraph</div>
          <div className="graphbar__spacer" />

          <div className="graphbar__controls">
            <FancySelect
              labelRu="Раскладка"
              labelEn="Layout"
              value={direction}
              options={directionOptions}
              onChange={(v) => setDirection(String(v))}
              disabled={false}
            />

            <div className="field">
              <div className="field__label" data-en="Refresh" title="Refresh">
                Обновление
              </div>
              <button
                className="fselect"
                type="button"
                onClick={loadGraph}
                disabled={loading || !assistantId}
                title="Refresh"
              >
                <span className="fselect__value">
                  {loading ? "Загрузка…" : "Обновить граф"}
                </span>
                <span className="fselect__chev" aria-hidden="true">
                  ↻
                </span>
              </button>
            </div>
          </div>
        </div>

        {hint ? (
          <div className={error ? "error" : "hint"} style={{ marginTop: 8 }}>
            {hint}
          </div>
        ) : null}
        {error ? (
          <div className="error" style={{ marginTop: 8 }}>
            {error}
          </div>
        ) : null}
      </div>

      <div className="card graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
    </div>
  );
}
