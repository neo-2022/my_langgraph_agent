import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Tooltip (portal, единый стиль)
 * - scope="viewport": позиционирование fixed, clamp по окну
 * - scope="drawer": portal внутрь ближайшего .drawer, позиционирование absolute, clamp по drawer
 *
 * Использование:
 *   <Tooltip tip="..." scope="viewport"><button>...</button></Tooltip>
 *   <Tooltip tip="..." scope="drawer"><div>...</div></Tooltip>
 */
export default function Tooltip({
  tip,
  children,
  scope = "viewport",
  maxWidth = 320,
  offset = 10,
  className = "",
}) {
  const hostRef = useRef(null);
  const tipRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [scopeEl, setScopeEl] = useState(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const setAnyRef = (ref, value) => {
    if (!ref) return;
    if (typeof ref === "function") ref(value);
    else if (typeof ref === "object") ref.current = value;
  };

  const resolveScopeEl = useCallback(() => {
    const host = hostRef.current;
    if (!host) return null;

    if (scope === "drawer") {
      return host.closest(".drawer");
    }
    return document.body;
  }, [scope]);

  const computeBase = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;

    const sc = resolveScopeEl();
    if (!sc) return;

    setScopeEl(sc);

    const hr = host.getBoundingClientRect();

    if (scope === "drawer") {
      const sr = sc.getBoundingClientRect();
      setPos({
        left: hr.left + hr.width / 2 - sr.left,
        top: hr.bottom - sr.top + offset,
      });
    } else {
      setPos({
        left: hr.left + hr.width / 2,
        top: hr.bottom + offset,
      });
    }
  }, [resolveScopeEl, scope, offset]);

  useEffect(() => {
    if (!open) return;

    computeBase();
    const onReflow = () => computeBase();

    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);

    return () => {
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, computeBase]);

  // После рендера tooltip — меряем и клампим
  useEffect(() => {
    if (!open) return;
    const host = hostRef.current;
    const t = tipRef.current;
    const sc = scopeEl;

    if (!host || !t || !sc) return;

    const hr = host.getBoundingClientRect();
    const tr = t.getBoundingClientRect();

    const pad = 10;

    if (scope === "drawer") {
      const sr = sc.getBoundingClientRect();

      const spaceBelow = sr.bottom - hr.bottom - pad;
      const spaceAbove = hr.top - sr.top - pad;

      const wantUp = spaceAbove >= tr.height + pad && spaceAbove > spaceBelow;

      let top = wantUp ? hr.top - sr.top - tr.height - pad : hr.bottom - sr.top + pad;
      top = Math.max(pad, Math.min(sr.height - tr.height - pad, top));

      let left = hr.left + hr.width / 2 - sr.left;
      const halfW = tr.width / 2;
      left = Math.max(pad + halfW, Math.min(sr.width - pad - halfW, left));

      setPos({ left, top });
    } else {
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const spaceBelow = vh - hr.bottom - pad;
      const spaceAbove = hr.top - pad;

      const wantUp = spaceAbove >= tr.height + pad && spaceAbove > spaceBelow;

      let top = wantUp ? hr.top - tr.height - pad : hr.bottom + pad;
      top = Math.max(pad, Math.min(vh - tr.height - pad, top));

      let left = hr.left + hr.width / 2;
      const halfW = tr.width / 2;
      left = Math.max(pad + halfW, Math.min(vw - pad - halfW, left));

      setPos({ left, top });
    }
  }, [open, scopeEl, scope]);

  if (!tip) return children;

  // Должен быть один React-element (button/div). И главное: НЕ ломаем исходный ref.
  const el = children;
  const originalRef = el?.ref;

  const child = {
    ...el,
    props: {
      ...el.props,
      ref: (node) => {
        hostRef.current = node;
        setAnyRef(originalRef, node);
      },
      onMouseEnter: (e) => {
        el.props?.onMouseEnter?.(e);
        setOpen(true);
      },
      onMouseLeave: (e) => {
        el.props?.onMouseLeave?.(e);
        setOpen(false);
      },
      onFocus: (e) => {
        el.props?.onFocus?.(e);
        setOpen(true);
      },
      onBlur: (e) => {
        el.props?.onBlur?.(e);
        setOpen(false);
      },
      "aria-label": el.props?.["aria-label"] || tip,
      tabIndex: el.props?.tabIndex ?? 0,
    },
  };

  // Portal target
  const target = scope === "drawer" ? scopeEl : document.body;

  const bubble =
    open && target
      ? createPortal(
          <div
            ref={tipRef}
            className={`tt__bubble ${
              scope === "drawer" ? "tt__bubble--drawer" : "tt__bubble--viewport"
            } ${className}`}
            style={{
              position: scope === "drawer" ? "absolute" : "fixed",
              left: pos.left,
              top: pos.top,
              transform: "translateX(-50%)",
              maxWidth: `min(${maxWidth}px, calc(100% - 20px))`,
              pointerEvents: "none",
            }}
          >
            {tip}
          </div>,
          target
        )
      : null;

  return (
    <>
      {child}
      {bubble}
    </>
  );
}
