import { useRef, useState } from "react";
import { PANE_LIMITS, useApp, type PaneWidths } from "../lib/store";
import { cx } from "./ui";

/**
 * Vertical drag handle between two panes. `side` says where the resized pane sits:
 * "left" grows when dragged right, "right" grows when dragged left. Double-click resets.
 * Arrow keys nudge it when focused.
 */
export function ResizeHandle({ pane, side }: { pane: keyof PaneWidths; side: "left" | "right" }) {
  const width = useApp((s) => s.paneWidths[pane]);
  const setWidth = useApp((s) => s.setPaneWidth);
  const start = useRef<{ x: number; w: number } | null>(null);
  const [active, setActive] = useState(false);
  const dir = side === "left" ? 1 : -1;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={PANE_LIMITS[pane].min}
      aria-valuemax={PANE_LIMITS[pane].max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.target as Element).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
        setActive(true);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s) setWidth(pane, s.w + dir * (e.clientX - s.x));
      }}
      onPointerUp={() => {
        start.current = null;
        setActive(false);
      }}
      onPointerCancel={() => {
        start.current = null;
        setActive(false);
      }}
      onDoubleClick={() => setWidth(pane, PANE_LIMITS[pane].def)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const step = (e.shiftKey ? 40 : 10) * (e.key === "ArrowRight" ? 1 : -1) * dir;
          setWidth(pane, width + step);
        }
      }}
      className={cx(
        "group relative z-10 -mx-[3px] w-[6px] shrink-0 cursor-col-resize touch-none outline-none select-none",
        "focus-visible:bg-accent/30",
      )}
    >
      <span
        className={cx(
          "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
          active ? "bg-accent" : "bg-transparent group-hover:bg-accent/60",
        )}
      />
    </div>
  );
}
