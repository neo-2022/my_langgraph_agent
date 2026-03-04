import { useEffect, useMemo, useRef, useState } from "react";
import Tooltip from "./Tooltip.jsx";

/**
 * SplitView
 * modes: "run" | "split"
 */
function getClientX(event) {
  if (!event) return null;
  if ("touches" in event && event.touches?.[0]) {
    return event.touches[0].clientX;
  }
  if ("changedTouches" in event && event.changedTouches?.[0]) {
    return event.changedTouches[0].clientX;
  }
  return event.clientX ?? null;
}

export default function SplitView({
  mode,
  onModeChange, // eslint-disable-line no-unused-vars
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

  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const calc = () => setIsNarrow(window.innerWidth < 980);
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  const startDrag = (event) => {
    if (mode !== "split" || isNarrow) return;
    const root = rootRef.current;
    const clientX = getClientX(event);
    if (!root || typeof clientX !== "number" || Number.isNaN(clientX)) return;

    const rect = root.getBoundingClientRect();
    const curPct = leftPct;

    dragRef.current = {
      active: true,
      startX: clientX,
      startPct: curPct,
      rectW: rect.width || 1,
    };
    setIsDragging(true);
    event?.preventDefault?.();

    const onMove = (moveEvent) => {
      moveEvent?.preventDefault?.();
      const st = dragRef.current;
      if (!st.active) return;

      const moveX = getClientX(moveEvent);
      if (typeof moveX !== "number" || Number.isNaN(moveX)) return;

      const dx = moveX - st.startX;
      const px = (st.startPct / 100) * st.rectW + dx;
      const pct = (px / st.rectW) * 100;
      const clamped = Math.max(22, Math.min(78, pct));
      setLeftPct(clamped);
    };

    const onUp = () => {
      dragRef.current.active = false;
      setIsDragging(false);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("touchmove", onMove, true);
      window.removeEventListener("touchend", onUp, true);
      window.removeEventListener("touchcancel", onUp, true);
    };

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("touchmove", onMove, { capture: true, passive: false });
    window.addEventListener("touchend", onUp, true);
    window.addEventListener("touchcancel", onUp, true);
  };

  return (
    <div className="sv" ref={rootRef}>
      {mode === "run" ? (
        <div className="sv__single" style={{ minWidth: 360 }}>{left}</div>
      ) : isNarrow ? (
        <div className="sv__stack">
          <div className="sv__stack-pane">{left}</div>
          <div className="sv__stack-pane">{right}</div>
        </div>
      ) : (
        <div className="sv__split" data-dragging={isDragging ? "1" : "0"}>
          <div
            className="sv__pane sv__pane--left"
            style={{
              width: `${leftPct}%`,
              flexBasis: `${leftPct}%`,
              flexGrow: 0,
              flexShrink: 0,
              minWidth: 360,
            }}
          >
            {left}
          </div>

          <Tooltip tip="Потяни, чтобы изменить ширину" scope="viewport">
            <div
              className="sv__divider"
              onMouseDown={startDrag}
              onTouchStart={startDrag}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize"
            >
              <div className="sv__divider-grip" />
            </div>
          </Tooltip>

          <div
            className="sv__pane sv__pane--right"
            style={{
              width: `${100 - leftPct}%`,
              flexBasis: `${100 - leftPct}%`,
              flexGrow: 0,
              flexShrink: 0,
              minWidth: 420,
            }}
          >
            {right}
          </div>
        </div>
      )}
    </div>
  );
}
