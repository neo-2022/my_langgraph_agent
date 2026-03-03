import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useEdgesState,
  useNodesState,
} from "reactflow";
import dagre from "dagre";
import Tooltip from "./Tooltip.jsx";
import "./GraphView.css";
import { httpClient } from "./obs/httpClient.js";

const graphCache = {
  nodes: [],
  edges: [],
  direction: "LR",
  fingerprint: "",
};

const GRAPH_POS_STORAGE_PREFIX = "lg_graph_positions:";

function storageKeyForAssistant(assistantId) {
  if (!assistantId) return null;
  return `${GRAPH_POS_STORAGE_PREFIX}${String(assistantId)}`;
}

function readStoredPositions(assistantId) {
  const key = storageKeyForAssistant(assistantId);
  if (!key || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function applyStoredPositions(nodes, stored, direction) {
  if (!stored || typeof stored !== "object" || !nodes.length) {
    return nodes;
  }
  const entry = stored[String(direction)] || {};
  const positions = entry.positions || {};
  return nodes.map((node) => {
    const id = String(node?.id ?? "");
    if (!id) return node;
    const storedPos = positions[id];
    if (
      storedPos &&
      typeof storedPos === "object" &&
      Number.isFinite(Number(storedPos.x)) &&
      Number.isFinite(Number(storedPos.y))
    ) {
      return {
        ...node,
        position: {
          x: Number(storedPos.x),
          y: Number(storedPos.y),
        },
      };
    }
    return node;
  });
}

function persistStoredPositions(assistantId, nodes, direction) {
  const key = storageKeyForAssistant(assistantId);
  if (!key || typeof window === "undefined") return;
  if (!nodes?.length) return;
  const payload = {};
  nodes.forEach((node) => {
    const id = String(node?.id ?? "");
    if (!id) return;
    const pos = node?.position;
    if (!pos) return;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    payload[id] = { x, y };
  });
  if (!Object.keys(payload).length) return;
  const existing = readStoredPositions(assistantId) || {};
  existing[String(direction)] = { positions: payload };
  try {
    window.localStorage.setItem(key, JSON.stringify(existing));
  } catch {
    // ignore
  }
}

function computeGraphFingerprint(apiNodes = [], apiEdges = []) {
  const nodeIds = Array.from(
    new Set(apiNodes.map((node) => String(node?.id ?? "")).filter(Boolean))
  )
    .sort()
    .join(",");
  const edgeKeys = Array.from(
    new Set(apiEdges.map((edge) => `${String(edge?.source ?? "")}->${String(edge?.target ?? "")}`))
  )
    .sort()
    .join(",");
  return `${nodeIds}|${edgeKeys}`;
}

const _consoleWarn = console.warn.bind(console);
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].includes("nodeTypes or edgeTypes object")) return;
  _consoleWarn(...args);
};

async function getJson(url, opts = {}) {
  return httpClient.get(url, opts);
}

function inferKindFromId(id) {
  if (id === "__start__") return "start";
  if (id === "__end__") return "end";
  if (id === "call_model") return "model";
  if (id === "tools") return "tools";
  return "";
}

function rfNodeFromApi(n) {
  const id = String(n?.id ?? "");
  const kind = String(n?.kind ?? "") || inferKindFromId(id);

  return {
    id,
    position: { x: 0, y: 0 },
    data: { label: String(n?.label ?? id) },
    type: "default",
    className: kind ? `lg-node--${kind}` : "",
    selected: false,
  };
}

function looksDashedEdge(e) {
  const kind = String(e?.kind ?? e?.type ?? "");
  const dashedFlag =
    Boolean(e?.dashed) ||
    Boolean(e?.dash) ||
    Boolean(e?.is_dashed) ||
    Boolean(e?.isDashed) ||
    /dash/i.test(kind);

  const styleDash =
    typeof e?.style?.strokeDasharray === "string" ||
    typeof e?.style?.strokeDasharray === "number";

  const directDash =
    typeof e?.strokeDasharray === "string" ||
    typeof e?.strokeDasharray === "number" ||
    typeof e?.stroke_dasharray === "string" ||
    typeof e?.stroke_dasharray === "number";

  return dashedFlag || styleDash || directDash;
}

function rfEdgeFromApi(e) {
  const id = String(e?.id ?? `${e?.source}->${e?.target}`);
  const source = String(e?.source ?? "");
  const target = String(e?.target ?? "");

  const dashFromApi = looksDashedEdge(e);

  // Пунктир “по смыслу”: все связи к узлу tools (если бэк не пометил их сам)
  const s = source.toLowerCase();
  const t = target.toLowerCase();
  const isToolsEdge = s === "tools" || t === "tools";

  const dashed = dashFromApi || isToolsEdge;

  // animated: если бэк дал — оставляем, иначе включаем для dashed
  const animated = Boolean(e?.animated) || dashed;

  const dashValue =
    typeof e?.style?.strokeDasharray === "string" ||
    typeof e?.style?.strokeDasharray === "number"
      ? String(e.style.strokeDasharray)
      : typeof e?.strokeDasharray === "string" ||
          typeof e?.strokeDasharray === "number"
        ? String(e.strokeDasharray)
        : typeof e?.stroke_dasharray === "string" ||
            typeof e?.stroke_dasharray === "number"
          ? String(e.stroke_dasharray)
          : "6 4";

  const style = dashed
    ? { ...(e?.style || {}), strokeDasharray: dashValue }
    : e?.style
      ? { ...e.style }
      : undefined;

  const className = [
    isToolsEdge ? "lg-edge--tools" : "",
    animated ? "lg-edge--animated" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id,
    source,
    target,
    label: e?.label ? String(e.label) : "",
    animated,
    style,
    className,
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
      if (typeof buttonRefExternal === "object" && buttonRefExternal) {
        buttonRefExternal.current = el;
      }
    },
    [buttonRefExternal]
  );

  const selected = options.find((o) => String(o.value) === String(value));
  const close = useCallback(() => setOpen(false), []);

  const compute = useCallback(() => {
    const b = btnRef.current;
    if (!b) return false;

    const r = b.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;

    const width = r.width;
    const left = Math.max(10, Math.min(window.innerWidth - width - 10, r.left));
    const top = r.bottom + 8;

    setMenuPos({ left, top, width });
    return true;
  }, []);

  useEffect(() => {
    if (!open) return;

    if (!compute()) {
      close();
      return;
    }

    const onDoc = (e) => {
      const b = btnRef.current;
      const m = menuRef.current;
      if (!b || !m) return;
      if (b.contains(e.target) || m.contains(e.target)) return;
      close();
    };

    const onReflow = () => {
      if (!compute()) close();
    };

    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onReflow, { capture: true, passive: true });
    window.addEventListener("resize", onReflow);

    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onReflow, { capture: true });
      window.removeEventListener("resize", onReflow);
    };
  }, [open, compute, close]);

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
    <>
      <Tooltip tip={tip} scope="viewport">
        <button
          ref={setBtnRef}
          type="button"
          className={`fselect ${disabled ? "fselect--disabled" : ""}`}
          onClick={() => {
            if (disabled) return;
            setOpen((v) => !v);
          }}
          aria-expanded={open ? "true" : "false"}
          disabled={disabled}
          style={{ width: "max-content", maxWidth: "70vw", marginTop: 0 }}
        >
          <span className="fselect__value" style={{ whiteSpace: "nowrap" }}>
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
      </Tooltip>
      {menu}
    </>
  );
}

export default function GraphView({ assistantId, focusNodeId = "", onNodeSelected }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [direction, setDirection] = useState("LR");
  const [nodes, setNodes, onNodesChange] = useNodesState(graphCache.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphCache.edges);
  const [graphVersion, setGraphVersion] = useState(0);

  const hasGraph = nodes.length > 0;

  const inFlightRef = useRef(false);
  const lastFetchRef = useRef({ key: "", ts: 0 });
  const abortRef = useRef(null);

  const rfRef = useRef(null);
  const wrapRef = useRef(null);
  const [hasViewportSize, setHasViewportSize] = useState(false);
  const manualPositionsRef = useRef(false);
  const manualPositionsRef = useRef(false);

  // Минимальный "пинок":
  // - ждём 2 кадра (layout -> paint), потом fitView
  // - диспатчим resize, чтобы ReactFlow точно пересчитал размеры
  const kick = useCallback((opts = {}) => {
    const padding = typeof opts.padding === "number" ? opts.padding : 0.25;
    const duration = typeof opts.duration === "number" ? opts.duration : 0;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          window.dispatchEvent(new Event("resize"));
        } catch {}
        const inst = rfRef.current;
        if (!inst) return;

        const el = wrapRef.current;
        const h = el ? Math.floor(el.getBoundingClientRect().height) : 0;
        if (h <= 0) return;

        try {
          inst.fitView?.({ padding, duration, includeHiddenNodes: true });
        } catch {}
      });
    });
  }, []);

  const normalizeFocusId = useCallback((id) => {
    const s = String(id || "");
    if (s === "agent" || s === "model") return "call_model";
    if (s === "user" || s === "start") return "__start__";
    if (s === "end") return "__end__";
    return s;
  }, []);

  const applyFocus = useCallback(
    (idRaw) => {
      const inst = rfRef.current;
      if (!inst) return;

      const nextId = normalizeFocusId(idRaw);

      setNodes((prev) =>
        prev.map((n) => ({
          ...n,
          selected: nextId ? String(n.id) === nextId : false,
        }))
      );

      if (!nextId) return;

      const liveNodes = typeof inst.getNodes === "function" ? inst.getNodes() : [];
      const node = liveNodes.find((n) => String(n.id) === nextId);
      if (!node) return;

      try {
        inst.fitView?.({
          nodes: [node],
          padding: 0.45,
          duration: 200,
          includeHiddenNodes: true,
        });
      } catch {}
    },
    [setNodes, normalizeFocusId]
  );

  const loadGraph = useCallback(async () => {
    if (!assistantId) return;

    const key = `${assistantId}|${direction}`;
    const now = Date.now();

    if (inFlightRef.current) return;
    if (lastFetchRef.current.key === key && now - lastFetchRef.current.ts < 1200) return;

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
      const data = await getJson(`/api/assistants/${assistantId}/graph`, {
        signal: ctrl.signal,
      });

      const apiNodes = Array.isArray(data?.nodes) ? data.nodes : [];
      const apiEdges = Array.isArray(data?.edges) ? data.edges : [];

      const fingerprint = computeGraphFingerprint(apiNodes, apiEdges);
      const canReuseCache =
        graphCache.direction === direction &&
        fingerprint &&
        fingerprint === graphCache.fingerprint &&
        graphCache.nodes.length === apiNodes.length &&
        graphCache.edges.length === apiEdges.length &&
        graphCache.nodes.length > 0 &&
        graphCache.edges.length > 0;

      if (canReuseCache) {
        setNodes(graphCache.nodes);
        setEdges(graphCache.edges);
        setGraphVersion((v) => v + 1);
        kick({ padding: 0.25, duration: 0 });
        return;
      }

      const rfNodes = apiNodes.map(rfNodeFromApi);
      const rfEdges = apiEdges.map(rfEdgeFromApi);

      const laid = layoutDagre(rfNodes, rfEdges, direction);
      const storedPositions = readStoredPositions(assistantId);
      const nodesWithPositions = applyStoredPositions(
        laid.nodes,
        storedPositions,
        direction
      );

      graphCache.direction = direction;
      graphCache.fingerprint = fingerprint;
      graphCache.nodes = nodesWithPositions;
      graphCache.edges = laid.edges;

      setNodes(nodesWithPositions);
      setEdges(laid.edges);
      setGraphVersion((v) => v + 1);

      // После установки nodes/edges — пинаем размеры/fitView
      kick({ padding: 0.25, duration: 0 });
    } catch (e) {
      if (String(e?.name) !== "AbortError") {
        setError(String(e?.message || e));
                try {
          window.__DBG0__?.pushError?.(e, {
            scope: "graph",
            severity: "error",
            message: String(e?.message || e),
            ctx: { where: "GraphView.catch" },
            actions: ["copy", "open"],
          });
        } catch {}
        // DBG0_GRAPHVIEW_CATCH
setNodes([]);
        setEdges([]);
        setGraphVersion((v) => v + 1);
      }
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [assistantId, direction, setNodes, setEdges, kick]);

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

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      const ok = rect.width > 40 && rect.height > 40;
      if (ok) setHasViewportSize(true);
    };

    measure();

    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => measure());
      ro.observe(el);
    }

    window.addEventListener("resize", measure);
    const t = window.setTimeout(measure, 50);

    return () => {
      try {
        ro?.disconnect?.();
      } catch {}
      window.removeEventListener("resize", measure);
      window.clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    if (hasViewportSize) return;
    let frame = 0;

    const poll = () => {
      const el = wrapRef.current;
      const rect = el?.getBoundingClientRect();
      if (rect && rect.width > 40 && rect.height > 40) {
        setHasViewportSize(true);
        return;
      }
      frame = window.requestAnimationFrame(poll);
    };

    frame = window.requestAnimationFrame(poll);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [hasViewportSize]);

  useEffect(() => {
    if (!assistantId) return;
    if (!hasViewportSize) return;
    if (nodes.length <= 0) return;
    kick({ padding: 0.25, duration: 0 });
  }, [assistantId, direction, graphVersion, nodes.length, hasViewportSize, kick]);

  useEffect(() => {
    if (!assistantId) return;
    if (!hasViewportSize) return;
    applyFocus(focusNodeId);
  }, [assistantId, direction, focusNodeId, graphVersion, hasViewportSize, applyFocus]);

  useEffect(() => {
    graphCache.nodes = nodes;
  }, [nodes]);

  useEffect(() => {
    graphCache.edges = edges;
  }, [edges]);

  useEffect(() => {
    if (!manualPositionsRef.current) return;
    persistStoredPositions(assistantId, nodes, direction);
    manualPositionsRef.current = false;
  }, [assistantId, nodes, direction]);

  useEffect(() => {
    manualPositionsRef.current = false;
  }, [assistantId, direction]);

  // Tooltip patch for ReactFlow controls
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
    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["title"],
    });
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

  const onPaneClick = useCallback(() => {
    onNodeSelected?.("");
    applyFocus("");
  }, [applyFocus, onNodeSelected]);

  const handleNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes);
      if (manualPositionsRef.current) return;
      const hasPositionChange = changes.some(
        (change) => String(change?.type || "").toLowerCase() === "position"
      );
      if (hasPositionChange) {
        manualPositionsRef.current = true;
      }
    },
    [onNodesChange]
  );

  const onFlowError = useCallback((id, message) => {
    if (String(id) === "002") return;
    if (message) {
      console.warn(`[React Flow]: ${message}`);
    }
  }, []);

  useEffect(() => {
    const originalWarn = console.warn;
    console.warn = (...args) => {
      if (typeof args[0] === "string" && args[0].includes("nodeTypes or edgeTypes object")) {
        return;
      }
      originalWarn(...args);
    };
    return () => {
      console.warn = originalWarn;
    };
  }, []);

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

  const hint = useMemo(() => {
    if (!assistantId) return "Нет assistant_id. Открой Run и убедись, что /api доступен.";
    if (loading) return "Загружаю граф…";
    if (error) return "Ошибка загрузки графа.";
    if (!hasGraph) return "Граф пустой.";
    return "";
  }, [assistantId, loading, error, hasGraph]);


  return (
    <div
      className="card graphview"
      style={{
                minHeight: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        alignSelf: "stretch",
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
          <div
            className="graphbar__controls"
            style={{ alignItems: "center", flexWrap: "nowrap" }}
          >
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

      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative" }}>
        {hasViewportSize ? (
            <ReactFlow
              style={{ position: "absolute", inset: 0 }}
              nodes={nodes}
              edges={edges}
              onInit={(inst) => {
                rfRef.current = inst;
                kick({ padding: 0.25, duration: 0 });
              }}
              onNodesChange={handleNodesChange}
              onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onError={onFlowError}
            fitView
            fitViewOptions={{ padding: 0.25, includeHiddenNodes: true }}
          >
            <Background />
            <MiniMap />
            <Controls />
          </ReactFlow>
        ) : (
          <div className="graphview__waiting">Подготавливаю граф...</div>
        )}
      </div>
    </div>
  );
}
