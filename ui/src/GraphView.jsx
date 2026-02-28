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

  const className = ["lg-node", isStart ? "lg-node--start" : "", isEnd ? "lg-node--end" : ""]
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
 * FancySelect: меню порталом в body.
 * Даём наружу ref на кнопку (buttonRefExternal), чтобы синхронизировать ширину Refresh.
 */
function FancySelect({
  value,
  options,
  onChange,
  disabled,
  placeholder = "—",
  tip,
  buttonRefExternal,
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0, width: 260 });

  const selected = options.find((o) => String(o.value) === String(value)) || null;
  const close = useCallback(() => setOpen(false), []);

  const setBtnRef = useCallback(
    (el) => {
      btnRef.current = el;
      if (buttonRefExternal) buttonRefExternal.current = el;
    },
    [buttonRefExternal]
  );

  const computePos = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = r.width;
    const maxH = 320;

    const spaceBelow = window.innerHeight - r.bottom - 10;
    const spaceAbove = r.top - 10;
    const openDown = spaceBelow >= Math.min(maxH, 220) || spaceBelow >= spaceAbove;

    const top = openDown ? r.bottom + 4 : Math.max(10, r.top - 4 - Math.min(maxH, 300));

    setMenuPos({
      left: Math.min(window.innerWidth - 10 - w, Math.max(10, r.left)),
      top,
      width: w,
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
    <>
      <button
        ref={setBtnRef}
        type="button"
        className={`fselect ${disabled ? "fselect--disabled" : ""}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-expanded={open ? "true" : "false"}
        disabled={disabled}
        data-tip={tip || ""}
        aria-label={tip || "Выбор"}
        style={{
          width: "max-content",   // ширина по контенту
          maxWidth: "70vw",
          marginTop: 0,           // на всякий
        }}
      >
        <span className="fselect__value" style={{ whiteSpace: "nowrap" }}>
          {selected ? selected.label : <span className="fselect__placeholder">{placeholder}</span>}
        </span>
        <span className="fselect__chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {menu}
    </>
  );
}

export default function GraphView({ assistantId, focusNodeId = "", onNodeSelected }) {
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

  // Убираем нативные title у ReactFlow Controls
  useEffect(() => {
    const root = document.querySelector(".react-flow");
    if (!root) return;

    const patch = () => {
      const buttons = root.querySelectorAll(".react-flow__controls button");
      buttons.forEach((btn) => {
        const t = btn.getAttribute("title");
        if (t && !btn.getAttribute("data-tip")) btn.setAttribute("data-tip", t);
        if (t) btn.removeAttribute("title");
      });
    };

    patch();
    const mo = new MutationObserver(() => patch());
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
    return () => mo.disconnect();
  }, []);

  // RU подписи для Controls (в т.ч. замок)
  useEffect(() => {
    const root = document.querySelector(".react-flow");
    if (!root) return;

    const setTips = () => {
      const buttons = root.querySelectorAll(".react-flow__controls button");
      buttons.forEach((btn) => {
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        let tip = btn.getAttribute("data-tip") || "";

        if (aria.includes("zoom in")) tip = "Увеличить";
        else if (aria.includes("zoom out")) tip = "Уменьшить";
        else if (aria.includes("fit view")) tip = "Вписать";
        else if (aria.includes("interactivity")) tip = "Интерактив";
        else if (aria.includes("interactive")) tip = "Интерактив";
        else if (aria.includes("lock")) tip = "Интерактив";

        if (tip) btn.setAttribute("data-tip", tip);
      });
    };

    setTips();
    const id = window.setInterval(setTips, 500);
    return () => window.clearInterval(id);
  }, []);

  const onNodeClick = useCallback(
    (_e, node) => {
      onNodeSelected?.(String(node?.id || ""));
    },
    [onNodeSelected]
  );

  const dirOptions = useMemo(
    () => [
      { value: "LR", label: "LR (слева→вправо)" },
      { value: "TB", label: "TB (сверху→вниз)" },
    ],
    []
  );

  // Refresh width = width of the direction button (exact)
  const dirBtnRef = useRef(null);
  const [refreshW, setRefreshW] = useState(0);

  const measure = useCallback(() => {
    const el = dirBtnRef.current;
    if (!el) return;
    const w = Math.ceil(el.getBoundingClientRect().width);
    if (w > 0) setRefreshW(w);
  }, []);

  useEffect(() => {
    measure();

    const el = dirBtnRef.current;
    if (!el) return;

    // Самый надёжный способ: следим за размером кнопки (текст/шрифт/масштаб)
    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => measure());
      ro.observe(el);
    }

    const onResize = () => measure();
    window.addEventListener("resize", onResize);

    // Доп. замер чуть позже (шрифты/рендер)
    const t = window.setTimeout(() => measure(), 50);

    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(t);
      try {
        ro?.disconnect?.();
      } catch {}
    };
  }, [measure, direction]);

  return (
    <div
      className="card"
      style={{
        height: "100%",
        minHeight: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: 12,
          borderBottom: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(255,255,255,0.03)",
        }}
      >
        <div className="graphbar">
          <div className="graphbar__controls" style={{ alignItems: "center", flexWrap: "nowrap" }}>
            <FancySelect
              value={direction}
              options={dirOptions}
              onChange={(v) => setDirection(String(v))}
              disabled={!assistantId}
              placeholder="LR/TB"
              tip="Направление графа (LR/TB)"
              buttonRefExternal={dirBtnRef}
            />

            <button
              className="secondary-btn"
              type="button"
              onClick={loadGraph}
              disabled={!assistantId || loading}
              data-tip="Обновить граф"
              aria-label="Обновить граф"
              style={{
                height: 42,
                width: refreshW ? `${refreshW}px` : undefined,
                marginTop: 0, // ВАЖНО: убрать любые сдвиги
              }}
            >
              {loading ? "Загружаю…" : "Refresh"}
            </button>
          </div>

          <div className="graphbar__spacer" />

          <div className="hint" style={{ marginTop: 0 }}>
            {hint}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactFlow
          className="lg-node"
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          fitView
        >
          <Background />
          <MiniMap />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
