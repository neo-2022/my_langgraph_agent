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
import { getTraceId } from "./obs/correlation.js";

const graphCache = {
  nodes: [],
  edges: [],
  direction: "LR",
  fingerprint: "",
};

const GRAPH_UI_CONTEXT = { ui: { tab: "graph" }, origin: "graph" };

function pushGraphEvent(event = {}) {
  if (typeof window === "undefined") return;
  const target = window.__DBG0__;
  if (!target || typeof target.pushEvent !== "function") return;
  try {
    target.pushEvent({
      level: event.level || "info",
      message: event.message,
      name: event.name || "graph.event",
      payload: event.payload,
      attrs: event.attrs,
      ctx: event.ctx,
      ...GRAPH_UI_CONTEXT,
    });
  } catch {}
}

function pushGraphSnapshot(data = {}) {
  if (typeof window === "undefined") return;
  const target = window.__DBG0__;
  if (!target || typeof target.pushSnapshot !== "function") return;
  try {
    target.pushSnapshot({
      channel: "graph",
      data,
    });
  } catch {}
}

const GRAPH_POS_STORAGE_PREFIX = "lg_graph_positions:";

export function buildGraphEmptyEvent({
  assistantId,
  direction,
  containerRect,
  nodesCount,
  edgesCount,
  inFlight,
  lastFetchMs,
}) {
  const width = Math.max(0, Math.round(containerRect?.width || 0));
  const height = Math.max(0, Math.round(containerRect?.height || 0));
  return {
    name: "ui.graph.empty",
    level: "warn",
    message: "Граф пуст",
    payload: {
      assistantId,
      direction,
      nodes: nodesCount,
      edges: edgesCount,
    },
    ctx: {
      assistant_id: assistantId,
      container_w: width,
      container_h: height,
      nodes_count: nodesCount,
      edges_count: edgesCount,
      in_flight: !!inFlight,
      last_fetch_ms: Number.isFinite(lastFetchMs) ? Math.max(-1, Math.round(lastFetchMs)) : -1,
      trace_id: getTraceId(),
    },
  };
}

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

function durationFromInfo(info) {
  if (!info) return undefined;
  if (Number.isFinite(Number(info.duration))) {
    return Number(info.duration);
  }
  const started = Number(info.startedAt ?? info.startTs);
  const finished = Number(info.finishedAt);
  if (Number.isFinite(started) && Number.isFinite(finished)) {
    return finished - started;
  }
  if (Number.isFinite(started)) {
    return Date.now() - started;
  }
  return undefined;
}

function formatDurationLabel(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const ms = Number(value);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
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

export default function GraphView({
  assistantId,
  focusNodeId = "",
  onNodeSelected,
  onInspectNode,
}) {
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
  const [nodeStatusTick, setNodeStatusTick] = useState(0);
  const nodeStatusRef = useRef({});
  const [hoveredNodeInfo, setHoveredNodeInfo] = useState(null);
  const spanToNodeRef = useRef({});
  const [highlightedEdgeId, setHighlightedEdgeId] = useState("");
  const [conditionalEdgeIds, setConditionalEdgeIds] = useState(new Set());
  const edgeDetailsRef = useRef(new Map());
  const selectedNodeIdRef = useRef("");

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

  const dispatchInspectNode = useCallback(
    (nodeId) => {
      const normalized = String(nodeId || "");
      selectedNodeIdRef.current = normalized;
      const info = normalized ? nodeStatusRef.current[String(normalized)] || null : null;
      if (typeof onInspectNode === "function") {
        onInspectNode(normalized, info);
      }
      return normalized;
    },
    [onInspectNode]
  );

  const handleNodeMouseEnter = useCallback(
    (_evt, node) => {
      if (!node) {
        setHoveredNodeInfo(null);
        return;
      }
      const nodeId = String(node.id || "");
      if (!nodeId) {
        setHoveredNodeInfo(null);
        return;
      }
      const info = node.data?.statusInfo || nodeStatusRef.current[nodeId] || null;
      if (info) {
        setHoveredNodeInfo({ nodeId, info });
      } else {
        setHoveredNodeInfo(null);
      }
    },
    []
  );

  const handleNodeMouseLeave = useCallback(() => {
    setHoveredNodeInfo(null);
  }, []);

  const normalizeFocusId = useCallback((id) => {
    const s = String(id || "");
    if (s === "agent" || s === "model") return "call_model";
    if (s === "user" || s === "start") return "__start__";
    if (s === "end") return "__end__";
    return s;
  }, []);

  const stripStatusClasses = useCallback((className = "") => {
    if (!className) return "";
    return className.replace(/\blg-node--status-\w+\b/g, "").replace(/\blg-node--slow\b/g, "").trim();
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

      if (!nextId) {
        dispatchInspectNode("");
        return;
      }
      dispatchInspectNode(nextId);

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

  const recordNodeStatus = useCallback(
    (nodeId, info) => {
      if (!nodeId) return;
      const next = { ...(nodeStatusRef.current || {}) };
      next[nodeId] = { ...(next[nodeId] || {}), ...info };
      nodeStatusRef.current = next;
      setNodeStatusTick((prev) => prev + 1);
      if (String(selectedNodeIdRef.current) === String(nodeId)) {
        dispatchInspectNode(nodeId);
      }
    },
    [dispatchInspectNode]
  );

  const handleDebugEvent = useCallback(
    (ev) => {
      if (!ev || typeof ev !== "object") return;
      const ctx = ev.context && typeof ev.context === "object" ? ev.context : {};
      const nodeId = String(ctx.node_id || ev.node_id || "").trim();
      const spanId = String(ctx.span_id || ev.span_id || "").trim();
      const parentSpanId = String(ctx.parent_span_id || ev.parent_span_id || "").trim();
      const type = String(ev.type || ev.kind || ev.name || "").toLowerCase();
      const statusSignal = String(ev.status || ev.state || "").toLowerCase();
      const durationVal = Number.isFinite(Number(ev.duration_ms ?? ev.duration ?? ev.run_duration ?? 0))
        ? Number(ev.duration_ms ?? ev.duration ?? ev.run_duration ?? 0)
        : undefined;

      if (spanId && nodeId) {
        spanToNodeRef.current[spanId] = nodeId;
      }

      if (nodeId) {
        const info = { ...(nodeStatusRef.current[nodeId] || {}) };
        const now = Date.now();
        if (type === "node_start") {
          info.status = "running";
          info.startTs = now;
          info.duration = undefined;
          info.startedAt = ev.ts ? Date.parse(ev.ts) : now;
        } else if (type === "node_end" || type === "node_done") {
          info.status = statusSignal === "error" ? "error" : "done";
          info.duration = durationVal ?? info.duration;
          info.finishedAt = now;
        } else if (type === "tool_start") {
          info.status = "running";
          info.tool = ev?.payload?.tool_name || info.tool;
          info.startTs = now;
        } else if (type === "tool_end") {
          info.status = statusSignal === "error" ? "error" : "done";
          info.duration = durationVal ?? info.duration;
        }
        info.spanId = spanId || info.spanId;
        if (parentSpanId) {
          info.parentSpanId = parentSpanId;
          const parentNode = spanToNodeRef.current[parentSpanId];
          if (parentNode) info.parentNode = parentNode;
        }
        if (info.status === "running" && info.startTs) {
          info.isSlow = now - Number(info.startTs) > 2000;
        } else if (info.duration) {
          info.isSlow = Number(info.duration) > 2000;
        }
        const summary = {
          id: String(ev?.event_id || `${type}-${nodeId}-${now}`),
          ts: ev?.ts || now,
          name: ev?.name || type,
          message: String(ev?.message || (ev?.payload && ev.payload.message) || ""),
          payload: ev.payload,
        };
        const eventsArr = Array.isArray(info.events) ? info.events.slice(-6) : [];
        info.events = [...eventsArr, summary];
        if (ev.payload && typeof ev.payload === "object") {
          const shortResult = ev.payload.short_result || ev.payload.result;
          if (shortResult != null) {
            info.shortResult = typeof shortResult === "string" ? shortResult : JSON.stringify(shortResult);
          }
          const shortError = ev.payload.short_error || ev.payload.error;
          if (shortError) {
            info.shortError = typeof shortError === "string" ? shortError : JSON.stringify(shortError);
          }
          if (ev.metadata && typeof ev.metadata === "object") {
            info.metadata = { ...(info.metadata || {}), ...ev.metadata };
          }
        }
        recordNodeStatus(nodeId, info);
      }

      if (type === "edge_chosen") {
        const edge = ev?.payload?.edge;
        const id = edge && typeof edge === "object" ? String(edge.id || `${edge.source ?? ""}->${edge.target ?? ""}`) : "";
        if (id) setHighlightedEdgeId(id);
      }
    },
    [recordNodeStatus]
  );

  const updateNodesForStatus = useCallback(() => {
    const statuses = nodeStatusRef.current || {};
    setNodes((prev) =>
      prev.map((node) => {
        const info = statuses[node.id];
        const baseClass = stripStatusClasses(node.className || "");
        if (!info) {
          return {
            ...node,
            className: baseClass,
            data: { ...node.data, statusInfo: undefined },
          };
        }
        const statusClass = `lg-node--status-${info.status || "running"}`;
        const slowClass = info.isSlow ? "lg-node--slow" : "";
        const originalLabel = node.data?.__lgOriginalLabel || node.data?.label || node.id;
        const parentBadge = info.parentNode
          ? (
            <div className="graphview__node-label">
              <span>{originalLabel}</span>
              <span className="graphview__parentBadge">called by {info.parentNode}</span>
            </div>
          )
          : originalLabel;
        return {
          ...node,
          className: [baseClass, statusClass, slowClass].filter(Boolean).join(" ").trim(),
          data: {
            ...node.data,
            statusInfo: info,
            label: parentBadge,
            __lgOriginalLabel: originalLabel,
          },
        };
      })
    );
  }, [setNodes, stripStatusClasses]);

  useEffect(() => {
    updateNodesForStatus();
  }, [nodeStatusTick, updateNodesForStatus]);

  const handleEdgeChosen = useCallback(
    (edgeEvent) => {
      const metadata = edgeEvent?.metadata || {};
      const payload = edgeEvent?.payload;
      const edge = payload?.edge || {};
      const id = String(edge?.id || `${edge?.source ?? ""}->${edge?.target ?? ""}`).trim();
      if (!id) return;
      const reason = String(edge?.reason || payload?.reason || "").trim();
      const labelBase = String(edge?.label || payload?.label || "conditional").trim();
      const label = reason ? `${labelBase} (${reason})` : labelBase;
      edgeDetailsRef.current.set(id, { label, reason, metadata });
      setHighlightedEdgeId(id);
      setEdges((prev) =>
        prev.map((e) => {
          if (e.id !== id) return e;
          return {
            ...e,
            label,
            data: {
              ...e.data,
              edgeReason: reason,
            },
          };
        })
      );
    },
    [setEdges]
  );

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const dbg0 = window.__DBG0__;
    if (!dbg0 || typeof dbg0.subscribeEvents !== "function") return undefined;
    const snap = typeof dbg0.snapshot === "function" ? dbg0.snapshot({ events: 400 }) : null;
    const events = Array.isArray(snap?.events) ? snap.events : [];
    events.forEach((ev) => {
      const type = String(ev?.type || ev?.kind || ev?.name || "").toLowerCase();
      if (type === "edge_chosen") {
        handleEdgeChosen(ev);
      }
      handleDebugEvent(ev);
    });
    const unsub = dbg0.subscribeEvents((ev) => {
      handleDebugEvent(ev);
      const type = String(ev?.type || ev?.kind || ev?.name || "").toLowerCase();
      if (type === "edge_chosen") {
        handleEdgeChosen(ev);
      }
    });
    return () => {
      try {
        if (typeof unsub === "function") unsub();
      } catch {}
    };
  }, [handleEdgeChosen, handleDebugEvent]);

  useEffect(() => {
    setEdges((prev) =>
      prev.map((edge) => {
        const isActive = highlightedEdgeId && edge.id === highlightedEdgeId;
        return {
          ...edge,
          style: {
            ...edge.style,
            stroke: isActive ? "rgba(185,200,255,0.96)" : "rgba(255,255,255,0.26)",
            strokeWidth: isActive ? 2.6 : 1.4,
          },
        };
      })
    );
  }, [highlightedEdgeId, setEdges]);

  const loadGraph = useCallback(async () => {
    if (!assistantId) return;

    const key = `${assistantId}|${direction}`;
    const now = Date.now();

    pushGraphEvent({
      name: "graph.fetch",
      message: "Запрос графа",
      payload: { assistantId, direction, status: "start" },
    });

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

      pushGraphEvent({
        name: "graph.fetch",
        message: "Граф получен",
        payload: {
          assistantId,
          direction,
          status: "success",
          nodes: Array.isArray(data?.nodes) ? data.nodes.length : 0,
          edges: Array.isArray(data?.edges) ? data.edges.length : 0,
        },
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
        pushGraphEvent({
          name: "graph.fetch",
          message: "Кэш графа использован",
          payload: { assistantId, direction, status: "cache" },
        });
        setNodes(graphCache.nodes);
        setEdges(graphCache.edges);
        setGraphVersion((v) => v + 1);
        kick({ padding: 0.25, duration: 0 });
        return;
      }

      const outgoingCounts = {};
      for (const edge of apiEdges) {
        const src = String(edge?.source || "");
        if (!src) continue;
        outgoingCounts[src] = (outgoingCounts[src] || 0) + 1;
      }
      const conditionalEdgeIds = new Set();
      for (const edge of apiEdges) {
        const src = String(edge?.source || "");
        if (!src) continue;
        if (outgoingCounts[src] > 1) {
          const id = String(edge?.id ?? `${edge?.source ?? ""}->${edge?.target ?? ""}`);
          conditionalEdgeIds.add(id);
        }
      }
      const rfNodes = apiNodes.map(rfNodeFromApi);
      const rfEdges = apiEdges.map((edge) => {
        const base = rfEdgeFromApi(edge);
        const isConditional = conditionalEdgeIds.has(base.id);
        const meta = edgeDetailsRef.current.get(base.id);
        const label = meta?.label
          ? meta.label
          : isConditional
            ? String(edge?.condition || edge?.label || "conditional")
            : base.label;
        const className = [base.className, isConditional ? "lg-edge--conditional" : ""]
          .filter(Boolean)
          .join(" ");
        return {
          ...base,
        label,
        isConditional,
        className,
        data: {
          ...base.data,
          reason: meta?.reason,
          metadata: meta?.metadata,
        },
        };
      });

      const laid = layoutDagre(rfNodes, rfEdges, direction);
      const storedPositions = readStoredPositions(assistantId);
      const nodesWithPositions = applyStoredPositions(
        laid.nodes,
        storedPositions,
        direction
      );

      pushGraphEvent({
        name: "graph.layout",
        message: "Позиционирование узлов",
        payload: {
          assistantId,
          direction,
          layout: "dagre",
          nodes: nodesWithPositions.length,
          edges: laid.edges.length,
        },
      });

      graphCache.direction = direction;
      graphCache.fingerprint = fingerprint;
      graphCache.nodes = nodesWithPositions;
      graphCache.edges = laid.edges;
      setConditionalEdgeIds(conditionalEdgeIds);

      const snapshotData = {
        assistantId,
        direction,
        layout: "dagre",
        fingerprint,
        nodes: nodesWithPositions.length,
        edges: laid.edges.length,
        details: {
          nodes: nodesWithPositions.map((node) => ({
            id: node.id,
            label: node.data?.label,
            position: node.position,
          })),
          edges: laid.edges.map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
          })),
        },
        status: nodesWithPositions.length ? "populated" : "empty",
      };
      pushGraphSnapshot(snapshotData);
      pushGraphEvent({
        name: "graph.render",
        message: "Граф отрисован",
        payload: {
          assistantId,
          direction,
          nodes: nodesWithPositions.length,
          edges: laid.edges.length,
        },
      });
      if (nodesWithPositions.length === 0 && laid.edges.length === 0) {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
          const now = Date.now();
          const startTs = lastFetchRef.current.ts || now;
          const lastFetchMs = Math.max(-1, now - startTs);
          const emptyEvent = buildGraphEmptyEvent({
            assistantId,
            direction,
            containerRect: rect,
            nodesCount: nodesWithPositions.length,
            edgesCount: laid.edges.length,
            inFlight: false,
            lastFetchMs,
          });
          pushGraphEvent(emptyEvent);
        }
      }

      setNodes(nodesWithPositions);
      setEdges(laid.edges);
      setGraphVersion((v) => v + 1);

      // После установки nodes/edges — пинаем размеры/fitView
      kick({ padding: 0.25, duration: 0 });
    } catch (e) {
      if (String(e?.name) !== "AbortError") {
        const message = String(e?.message || e);
        setError(message);
        try {
          window.__DBG0__?.pushError?.(e, {
            scope: "graph",
            severity: "error",
            message,
            ctx: { where: "GraphView.catch" },
            actions: ["copy", "open"],
          });
        } catch {}
        pushGraphEvent({
          name: "graph.fetch",
          level: "error",
          message: "Ошибка загрузки графа",
          payload: { assistantId, direction, error: message },
        });
        const snapshotData = {
          assistantId,
          direction,
          nodes: 0,
          edges: 0,
          status: "empty",
          error: message,
        };
        pushGraphSnapshot(snapshotData);
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
    const translations = {
      "zoom in": "Увеличить",
      "zoom out": "Уменьшить",
      "fit view": "Вписать",
      interactive: "Интерактив",
      lock: "Интерактив",
    };

    const patch = (root) => {
      const buttons = root.querySelectorAll(".react-flow__controls button");
      buttons.forEach((btn) => {
        const title = (btn.getAttribute("title") || "").trim();
        const aria = (btn.getAttribute("aria-label") || "").trim();
        const dataTip = (btn.getAttribute("data-tip") || "").trim();
        const existing = (dataTip || title || aria).trim();
        if (!existing) return;
        const key = existing.toLowerCase();
        const translation = translations[key];
        const tip = translation || existing;
        btn.setAttribute("data-tip", tip);
        if (translation && aria && aria !== translation) {
          btn.setAttribute("aria-label", translation);
        }
        if (title) {
          btn.removeAttribute("title");
        }
      });
    };

    let mo;
    let pollId;

    const establish = () => {
      const root = document.querySelector(".react-flow");
      if (!root) return false;
      patch(root);
      mo = new MutationObserver(() => patch(root));
      mo.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["title"],
      });
      return true;
    };

    if (!establish()) {
      pollId = window.setInterval(() => {
        if (establish() && pollId) {
          window.clearInterval(pollId);
          pollId = null;
        }
      }, 250);
    }

    return () => {
      mo?.disconnect();
      if (pollId) window.clearInterval(pollId);
    };
  }, []);

  const onNodeClick = useCallback(
    (_e, node) => {
      const id = String(node?.id || "");
      dispatchInspectNode(id);
      onNodeSelected?.(id);
    },
    [dispatchInspectNode, onNodeSelected]
  );

  const onPaneClick = useCallback(() => {
    dispatchInspectNode("");
    onNodeSelected?.("");
    applyFocus("");
  }, [applyFocus, onNodeSelected, dispatchInspectNode]);

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

  const hoverDescription = useMemo(() => {
    if (!hoveredNodeInfo) return "";
    const status = hoveredNodeInfo.info?.status || "idle";
    const durationVal = durationFromInfo(hoveredNodeInfo.info);
    const toolLabel = hoveredNodeInfo.info?.tool || hoveredNodeInfo.info?.tool_name;
    const parts = [`${hoveredNodeInfo.nodeId}`, status];
    if (Number.isFinite(Number(durationVal))) {
      parts.push(formatDurationLabel(durationVal));
    }
    if (toolLabel) {
      parts.push(`tool ${toolLabel}`);
    }
    return parts.join(" • ");
  }, [hoveredNodeInfo]);


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
          <div className="graphbar__hover">
            {hoverDescription ? (
              <span className="graphbar__hover__text">
                <span className="graphbar__hover__label">Состояние:</span>
                <strong>{hoverDescription}</strong>
              </span>
            ) : null}
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
              onNodeMouseEnter={handleNodeMouseEnter}
              onNodeMouseLeave={handleNodeMouseLeave}
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
