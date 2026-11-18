import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ensureFonts } from "./fonts";
import { assetIds, loadAssets, renderDesign, type Assets } from "./render";
import { loadPackFonts } from "./packs";
import { profileFor } from "./tcg/registry";
import type { CardDesign, Layer, TextLayer } from "./types";

interface Props {
  design: CardDesign;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** live change while dragging (not committed to history) */
  onPreview: (d: CardDesign | null) => void;
  /** final change (committed) */
  onCommit: (d: CardDesign) => void;
  snap: boolean;
  guides: boolean;
  onEditText: () => void;
  zoom: number;
  setZoom: (z: number) => void;
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rot";
const HANDLES: Record<Exclude<Handle, "rot">, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};
const CURSORS: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", rot: "grab" };

const rad = (d: number) => (d * Math.PI) / 180;
const rot = (x: number, y: number, a: number) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

function hit(l: Layer, px: number, py: number) {
  const cx = l.x + l.w / 2;
  const cy = l.y + l.h / 2;
  const [lx, ly] = rot(px - cx, py - cy, -rad(l.rotation));
  return Math.abs(lx) <= l.w / 2 && Math.abs(ly) <= l.h / 2;
}

interface Drag {
  mode: "move" | Handle;
  start: [number, number];
  orig: Layer;
  design: CardDesign;
}

export function CanvasEditor({ design, selectedId, onSelect, onPreview, onCommit, snap, guides, onEditText, zoom, setZoom }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 800, h: 600 });
  const [assets, setAssets] = useState<Assets>(new Map());
  const [fontsTick, setFontsTick] = useState(0);
  const [snapLines, setSnapLines] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const drag = useRef<Drag | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const W = design.width + 2 * design.bleed;
  const H = design.height + 2 * design.bleed;
  const fit = Math.max(1, Math.min((box.w - 96) / W, (box.h - 96) / H));
  const k = fit * zoom; // css px per mm

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // assets & fonts for the current design
  const imageKey = assetIds(design).join(",");
  useEffect(() => {
    let alive = true;
    loadAssets(design).then((a) => alive && setAssets(a));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKey]);
  const pack = profileFor(design.tcg?.game)?.packId;
  const fontKey = (pack ?? "") + design.layers.map((l) => (l.kind === "text" ? `${l.font}|${l.fallback}|${l.weight}|${l.italic}` : "")).join(",");
  useEffect(() => {
    const specs = design.layers
      .filter((l): l is TextLayer => l.kind === "text")
      .flatMap((t) => [t.font, t.fallback].filter((f): f is string => !!f).map((font) => ({ font, weight: t.weight, italic: t.italic })));
    (pack ? loadPackFonts(pack) : Promise.resolve())
      .then(() => ensureFonts(specs))
      .then(() => setFontsTick((t) => t + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontKey]);

  // draw
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(W * k * dpr);
    c.height = Math.round(H * k * dpr);
    const raf = requestAnimationFrame(() => renderDesign(c.getContext("2d")!, design, k * dpr, assets, true));
    return () => cancelAnimationFrame(raf);
  }, [design, k, assets, fontsTick, W, H]);

  // ---------------------------------------------------------------- pointer → mm
  const toMm = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  };

  const selected = design.layers.find((l) => l.id === selectedId) ?? null;

  const snapTargets = useCallback(
    (moving: string) => {
      const b = design.bleed;
      const s = design.safe;
      const xs = [0, W, b, W - b, b + s, W - b - s, W / 2];
      const ys = [0, H, b, H - b, b + s, H - b - s, H / 2];
      for (const l of design.layers) {
        if (l.id === moving || !l.visible || l.rotation) continue;
        xs.push(l.x, l.x + l.w / 2, l.x + l.w);
        ys.push(l.y, l.y + l.h / 2, l.y + l.h);
      }
      return { xs, ys };
    },
    [design, W, H],
  );

  const onPointerDown = (e: React.PointerEvent, mode: Drag["mode"] = "move") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = toMm(e);
    let target = selected;
    if (mode === "move") {
      target = [...design.layers].reverse().find((l) => l.visible && !l.locked && hit(l, p[0], p[1])) ?? null;
      onSelect(target?.id ?? null);
    }
    if (!target || target.locked) return;
    drag.current = { mode, start: p, orig: structuredClone(target), design };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [px, py] = toMm(e);
    const dx = px - d.start[0];
    const dy = py - d.start[1];
    const o = d.orig;
    let n: Layer = { ...o };
    const thr = 6 / k;
    const lines = { x: [] as number[], y: [] as number[] };

    if (d.mode === "move") {
      n.x = o.x + dx;
      n.y = o.y + dy;
      if (snap && !e.altKey) {
        const { xs, ys } = snapTargets(o.id);
        const edgesX = [n.x, n.x + n.w / 2, n.x + n.w];
        const edgesY = [n.y, n.y + n.h / 2, n.y + n.h];
        let best = { d: thr, off: 0, at: NaN };
        for (const ex of edgesX) for (const tx of xs) if (Math.abs(tx - ex) < best.d) best = { d: Math.abs(tx - ex), off: tx - ex, at: tx };
        if (!isNaN(best.at)) {
          n.x += best.off;
          lines.x.push(best.at);
        }
        best = { d: thr, off: 0, at: NaN };
        for (const ey of edgesY) for (const ty of ys) if (Math.abs(ty - ey) < best.d) best = { d: Math.abs(ty - ey), off: ty - ey, at: ty };
        if (!isNaN(best.at)) {
          n.y += best.off;
          lines.y.push(best.at);
        }
      }
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) n.y = o.y;
        else n.x = o.x;
      }
    } else if (d.mode === "rot") {
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      let a = (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
      if (e.shiftKey || snap) a = Math.round(a / (e.shiftKey ? 15 : 1)) * (e.shiftKey ? 15 : 1);
      a = ((a % 360) + 540) % 360 - 180;
      n.rotation = Math.abs(a) < 1.5 && snap ? 0 : Math.round(a * 10) / 10;
    } else {
      const [hx, hy] = HANDLES[d.mode];
      const a = rad(o.rotation);
      const [lx, ly] = rot(dx, dy, -a);
      let nw = Math.max(0.5, o.w + hx * lx);
      let nh = Math.max(0.5, o.h + hy * ly);
      if (e.shiftKey && hx && hy) {
        const r = o.w / o.h;
        if (nw / nh > r) nh = nw / r;
        else nw = nh * r;
      }
      const [cdx, cdy] = rot((hx * (nw - o.w)) / 2, (hy * (nh - o.h)) / 2, a);
      const cx = o.x + o.w / 2 + cdx;
      const cy = o.y + o.h / 2 + cdy;
      n = { ...n, w: nw, h: nh, x: cx - nw / 2, y: cy - nh / 2 };
    }
    n = { ...n, x: round(n.x), y: round(n.y), w: round(n.w), h: round(n.h) };
    setSnapLines(lines);
    onPreview({ ...d.design, layers: d.design.layers.map((l) => (l.id === o.id ? n : l)) });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setSnapLines({ x: [], y: [] });
    if (!d) return;
    const [px, py] = toMm(e);
    if (Math.hypot(px - d.start[0], py - d.start[1]) * k < 1 && d.mode === "move") return onPreview(null);
    onCommit(designRef.current);
  };

  // keep the latest preview design for commit
  const designRef = useRef(design);
  designRef.current = design;

  // ---------------------------------------------------------------- gestures (pinch / ctrl-wheel)
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let base: number | null = null;
    const clamp = (z: number) => Math.min(8, Math.max(0.25, z));
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || base !== null) return;
      e.preventDefault();
      const dy = Math.max(-60, Math.min(60, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
      setZoom(clamp(zoomRef.current * Math.exp(-dy * 0.01)));
    };
    const gs = (e: Event) => {
      e.preventDefault();
      base = zoomRef.current;
    };
    const gc = (e: Event) => {
      e.preventDefault();
      if (base !== null) setZoom(clamp(base * (e as Event & { scale: number }).scale));
    };
    const ge = (e: Event) => {
      e.preventDefault();
      base = null;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", gs);
    el.addEventListener("gesturechange", gc);
    el.addEventListener("gestureend", ge);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", gs);
      el.removeEventListener("gesturechange", gc);
      el.removeEventListener("gestureend", ge);
    };
  }, [setZoom]);

  // keep the card centred when the zoom changes
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  }, [zoom]);

  // ---------------------------------------------------------------- overlay geometry
  const cw = W * k;
  const ch = H * k;
  const sel = selected;
  const handlePts = sel
    ? (Object.entries(HANDLES) as [Handle, [number, number]][]).map(([h, [hx, hy]]) => {
        const a = rad(sel.rotation);
        const [ox, oy] = rot((hx * sel.w) / 2, (hy * sel.h) / 2, a);
        return { h, x: (sel.x + sel.w / 2 + ox) * k, y: (sel.y + sel.h / 2 + oy) * k };
      })
    : [];
  const rotPt = sel
    ? (() => {
        const a = rad(sel.rotation);
        const [ox, oy] = rot(0, -sel.h / 2 - 22 / k, a);
        return { x: (sel.x + sel.w / 2 + ox) * k, y: (sel.y + sel.h / 2 + oy) * k };
      })()
    : null;
  const b = design.bleed * k;
  const s = (design.bleed + design.safe) * k;

  return (
    <div ref={wrap} className="min-h-0 flex-1 overflow-auto bg-stage" onPointerDown={() => onSelect(null)}>
      <div className="flex min-h-full min-w-full items-center justify-center p-12" style={{ width: Math.max(box.w, cw + 96), height: Math.max(box.h, ch + 96) }}>
        <div className="relative shrink-0 shadow-2xl shadow-black/60" style={{ width: cw, height: ch }}>
          <canvas
            ref={canvas}
            style={{ width: cw, height: ch, display: "block" }}
            onPointerDown={(e) => onPointerDown(e)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => sel?.kind === "text" && onEditText()}
          />
          <svg width={cw} height={ch} className="pointer-events-none absolute inset-0 overflow-visible">
            {guides && (
              <g fill="none" strokeWidth={1}>
                <rect x={0.5} y={0.5} width={cw - 1} height={ch - 1} stroke="#f87171" strokeDasharray="4 3" />
                <rect x={b} y={b} width={cw - 2 * b} height={ch - 2 * b} stroke="#38bdf8" />
                <rect x={s} y={s} width={cw - 2 * s} height={ch - 2 * s} stroke="#4ade80" strokeDasharray="2 3" />
              </g>
            )}
            {snapLines.x.map((x) => (
              <line key={`x${x}`} x1={x * k} x2={x * k} y1={-20} y2={ch + 20} stroke="#e879f9" strokeWidth={1} />
            ))}
            {snapLines.y.map((y) => (
              <line key={`y${y}`} y1={y * k} y2={y * k} x1={-20} x2={cw + 20} stroke="#e879f9" strokeWidth={1} />
            ))}
            {sel && (
              <g transform={`rotate(${sel.rotation} ${(sel.x + sel.w / 2) * k} ${(sel.y + sel.h / 2) * k})`}>
                <rect x={sel.x * k} y={sel.y * k} width={sel.w * k} height={sel.h * k} fill="none" stroke="#f28c28" strokeWidth={1.5} />
              </g>
            )}
          </svg>
          {sel && !sel.locked && (
            <>
              {rotPt && (
                <div
                  onPointerDown={(e) => onPointerDown(e, "rot")}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-white"
                  style={{ left: rotPt.x, top: rotPt.y, cursor: CURSORS.rot }}
                  title="Girar (Shift: 15°)"
                />
              )}
              {handlePts.map((p) => (
                <div
                  key={p.h}
                  onPointerDown={(e) => onPointerDown(e, p.h)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 border-[1.5px] border-accent bg-white"
                  style={{ left: p.x, top: p.y, cursor: CURSORS[p.h] }}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const round = (v: number) => Math.round(v * 100) / 100;
