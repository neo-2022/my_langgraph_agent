import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactFlow, { Background, Controls, MiniMap, useEdgesState, useNodesState } from "reactflow";
import dagre from "dagre";
import Tooltip from "./Tooltip.jsx";
import "./GraphView.css";

async function getJson(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

function rfNodeFromApi(n) {
  const id = String(n?.id ?? "");
  return {
    id,
    position: { x: 0, y: 0 },
    data: { label: String(n?.label ?? id) },
    type: "default",
    className: n?.kind ? `lg-node--${n.kind}` : "",
  };
}
function rfEdgeFromApi(e) {
  return {
    id: String(e?.id ?? `${e?.source}->${e?.target}`),
    source: String(e?.source ?? ""),
    target: String(e?.target ?? ""),
    label: e?.label ? String(e.label) : "",
  };
}

function layoutDagre(nodes, edges, direction) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));

  const isLR = direction === "LR";
  g.setGraph({ rankdir: isLR ? "LR" : "TB", nodesep: 26, ranksep: 46 });

  nodes.forEach((n) => g.setNode(n.id, { width: 180, height: 46 }));
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  const laidNodes = nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x, y: p.y } };
  });

  return { nodes: laidNodes, edges };
}

function FancySelect({
  value,
  options,
  onChange,
  disabled,
  placeholder = "Select",
  tip = "",
  buttonRefExternal = null,
}) {
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0, width: 260 });

  const setBtnRef = useCallback(
    (el) => {
      btnRef.current = el;
      if (typeof buttonRefExternal === "object" && buttonRefExternal) buttonRefExternal.current = el;
    },
    [buttonRefExternal]
  );

  const selected = options.find((o) => String(o.value) === String(value));
  const close = () => setOpen(false);

  const compute = useCallback(() => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    setMenuPos({
      left: Math.max(10, Math.min(window.innerWidth - r.width - 10, r.left)),
      top: r.bottom + 8,
      width: r.width,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    compute();

    const onDoc = (e) => {
      const b = btnRef.current;
      const m = menuRef.current;
      if (!b || !m) return;
      if (b.contains(e.target) || m.contains(e.target)) return;
      close();
    };
    const onReflow = () => compute();

    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);

    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, compute]);

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
      <Tooltip tip={tip} scope="viewport">
        <button
          ref={setBtnRef}
          type="button"
          className={`fselect ${disabled ? "fselect--disabled" : ""}`}
          onClick={() => !disabled && setOpen((v) => !v)}
          aria-expanded={open ? "true" : "false"}
          disabled={disabled}
          style={{
            width: "max-content",
            maxWidth: "70vw",
            marginTop: 0,
          }}
        >
          <span className="fselect__value" style={{ whiteSpace: "nowrap" }}>
            {selected ? selected.label : <span className="fselect__placeholder">{placeholder}</span>}
          </span>
          <span className="fselect__chev" aria-hidden="true">
            ▾
          </span>
        </button>
      </Tooltip>
      {menu}
    </>
  );
}

export default function GraphView({ assistantId, focusNodeId = "", onNodeSelected }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [direction, setDirection] = useState("LR");
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const hasGraph = nodes.length > 0;

  const inFlightRef = useRef(false);
  const lastFetchRef = useRef({ key: "", ts: 0 });
  const abortRef = useRef(null);

  const loadGraph = useCallback(async () => {
    if (!assistantId) return;

    const key = `${assistantId}|${direction}`;
    const now = Date.now();

    if (inFlightRef.current) return;
    if (lastFetchRef.current.key === key && now - lastFetchRef.current.ts < 2000) return;

    lastFetchRef.current = { key, ts: now };
    inFlightRef.current = true;

    try {
      abortRef.current?.abort?.();
    } catch {}
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setError("");
    setLoading(true);

    try {
      const data = await getJson(`/api/assistants/${assistantId}/graph`, { signal: ctrl.signal });
      const apiNodes = Array.isArray(data?.nodes) ? data.nodes : [];
      const apiEdges = Array.isArray(data?.edges) ? data.edges : [];

      const rfNodes = apiNodes.map(rfNodeFromApi);
      const rfEdges = apiEdges.map(rfEdgeFromApi);

      const laid = layoutDagre(rfNodes, rfEdges, direction);
      setNodes(laid.nodes);
      setEdges(laid.edges);
    } catch (e) {
      if (String(e?.name) !== "AbortError") {
        setError(String(e?.message || e));
        setNodes([]);
        setEdges([]);
      }
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [assistantId, direction, setNodes, setEdges]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  useEffect(() => {
    return () => {
      try {
        abortRef.current?.abort?.();
      } catch {}
    };
  }, []);

  const hint = useMemo(() => {
    if (!assistantId) return "Нет assistant_id. Открой Run и убедись, что /api доступен.";
    if (loading) return "Загружаю граф…";
    if (error) return "Ошибка загрузки графа.";
    if (!hasGraph) return "Граф пустой.";
    return "";
  }, [assistantId, loading, error, hasGraph]);

  // ReactFlow Controls (lib) — оставляем data-tip + CSS override в GraphView.css
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

    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => measure());
      ro.observe(el);
    }

    const onResize = () => measure();
    window.addEventListener("resize", onResize);

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
      className="card graphview"
      style={{ height: "100%", minHeight: 0, padding: 0, display: "flex", flexDirection: "column" }}
    >
      <div style={{ padding: 12, borderBottom: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.03)" }}>
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

            <Tooltip tip="Обновить граф" scope="viewport">
              <button
                className="secondary-btn"
                type="button"
                onClick={loadGraph}
                disabled={!assistantId || loading}
                aria-label="Обновить граф"
                style={{
                  height: 42,
                  width: refreshW ? `${refreshW}px` : undefined,
                  marginTop: 0,
                }}
              >
                {loading ? "Загружаю…" : "Refresh"}
              </button>
            </Tooltip>
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
