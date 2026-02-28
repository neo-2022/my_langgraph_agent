import { useEffect, useMemo, useRef, useState } from "react";

/**
 * SplitView
 * modes: "run" | "graph" | "split"
 * - split: resizable horizontal split with draggable divider
 * - stores divider position in localStorage
 *
 * props:
 *   mode: string
 *   onModeChange: (mode)=>void
 *   left: ReactNode
 *   right: ReactNode
 *   storageKey?: string
 */
export default function SplitView({
  mode,
  onModeChange,
  left,
  right,
  storageKey = "splitview:left_pct",
}) {
  const rootRef = useRef(null);
  const dragRef = useRef({ active: false, startX: 0, startPct: 55 });

  const initialPct = useMemo(() => {
    const v = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(v) && v >= 20 && v <= 80) return v;
    return 55;
  }, [storageKey]);

  const [leftPct, setLeftPct] = useState(initialPct);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(leftPct));
    } catch {}
  }, [leftPct, storageKey]);

  // если экран очень узкий — принудительно не мучаем split
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const calc = () => {
      setIsNarrow(window.innerWidth < 980);
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  const startDrag = (e) => {
    if (mode !== "split") return;
    const root = rootRef.current;
    if (!root) return;

    const rect = root.getBoundingClientRect();
    const curPct = leftPct;

    dragRef.current = {
      active: true,
      startX: e.clientX,
      startPct: curPct,
      rectLeft: rect.left,
      rectW: rect.width,
    };
    setIsDragging(true);

    const onMove = (ev) => {
      const st = dragRef.current;
      if (!st.active) return;

      const dx = ev.clientX - st.startX;
      const px = (st.startPct / 100) * st.rectW + dx;
      const pct = (px / st.rectW) * 100;

      // ограничения чтобы не схлопывалось
      const clamped = Math.max(22, Math.min(78, pct));
      setLeftPct(clamped);
    };

    const onUp = () => {
      dragRef.current.active = false;
      setIsDragging(false);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
    };

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
  };

  const renderToolbar = () => (
    <div className="sv__toolbar">
      <button
        type="button"
        className={`sv__mode ${mode === "run" ? "sv__mode--active" : ""}`}
        onClick={() => onModeChange?.("run")}
        title="Run only"
      >
        Run
      </button>
      <button
        type="button"
        className={`sv__mode ${mode === "graph" ? "sv__mode--active" : ""}`}
        onClick={() => onModeChange?.("graph")}
        title="Graph only"
      >
        Graph
      </button>
      <button
        type="button"
        className={`sv__mode ${mode === "split" ? "sv__mode--active" : ""}`}
        onClick={() => onModeChange?.("split")}
        title="Split view"
      >
        Split
      </button>

      <div className="sv__spacer" />

      {mode === "split" && !isNarrow ? (
        <div className="sv__hint mono" title="Потяни разделитель мышью">
          перетащи разделитель ↔
        </div>
      ) : null}

      {isNarrow && mode === "split" ? (
        <div className="sv__hint mono" title="Слишком узко для Split — используем вертикальный стек">
          narrow → stack
        </div>
      ) : null}
    </div>
  );

  // layout:
  // - run or graph: single panel
  // - split: two panels
  //   - on narrow: stack vertical (top/bottom) with fixed heights
  return (
    <div className="sv" ref={rootRef}>
      {renderToolbar()}

      {mode === "run" ? (
        <div className="sv__single">{left}</div>
      ) : mode === "graph" ? (
        <div className="sv__single">{right}</div>
      ) : isNarrow ? (
        <div className="sv__stack">
          <div className="sv__stack-pane">{left}</div>
          <div className="sv__stack-pane">{right}</div>
        </div>
      ) : (
        <div className="sv__split" data-dragging={isDragging ? "1" : "0"}>
          <div className="sv__pane sv__pane--left" style={{ width: `${leftPct}%` }}>
            {left}
          </div>

          <div
            className="sv__divider"
            onMouseDown={startDrag}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize"
            title="Потяни, чтобы изменить ширину"
          >
            <div className="sv__divider-grip" />
          </div>

          <div className="sv__pane sv__pane--right" style={{ width: `${100 - leftPct}%` }}>
            {right}
          </div>
        </div>
      )}
    </div>
  );
}
