import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Eye, Layers, Loader2, Maximize, Maximize2, Minimize2, ZoomIn, ZoomOut } from "lucide-react";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { api, errorText, fileUrl } from "../lib/ipc";
import { moveInstance } from "../lib/deck";
import type { SlotMap } from "../lib/types";
import { usePageMap } from "./usePageMap";
import { cx, IconButton } from "./ui";

const DRAG_THRESHOLD = 4; // px before a press on a card becomes a drag

const PAD = 32; // stage padding (px)
const GAP = 24; // gap between pages (px)
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const QUICK_DPI = 30; // first, instant pass after an edit
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * All pages in one scrollable column, rendered by the Rust export pipeline.
 * Edits refresh visible pages in two passes: an instant low-resolution render, then a
 * sharp one at the current zoom. Trackpad: pinch to zoom around the cursor, two-finger
 * scroll to pan; mouse: Ctrl/⌘ + wheel to zoom, drag to pan; ⌘+ / ⌘− / ⌘0.
 */
export function Stage() {
  const t = useT();
  const project = useApp((s) => s.project)!;
  const profiles = useApp((s) => s.profiles);
  const images = useApp((s) => s.images);
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 800, h: 600 });
  const [zoom, setZoom] = useState(1);
  const [renderZoom, setRenderZoom] = useState(1);
  const pageMap = usePageMap();
  const pages = pageMap.length;
  const focus = useApp((s) => s.focus);
  const selected = useApp((s) => s.selectedCard);
  const [current, setCurrent] = useState(0);
  const [proof, setProof] = useState(false);
  const [gamut, setGamut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);
  const anchor = useRef<{ x: number; y: number; cx: number; cy: number; ratio: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // ----- geometry
  const l = project.layout;
  const [pw, ph] = useMemo(() => {
    const a = l.pageSize.width;
    const b = l.pageSize.height;
    const short = Math.min(a, b);
    const long = Math.max(a, b);
    return l.orientation === "portrait" ? [short, long] : [long, short];
  }, [l.pageSize, l.orientation]);
  const fitH = Math.max(200, viewport.h - 2 * PAD);
  const fitScale = Math.min(fitH / ph, (viewport.w - 2 * PAD) / pw); // px per mm at zoom 1
  const scale = fitScale * zoom;
  const pageW = pw * scale;
  const pageH = ph * scale;
  // render resolution follows zoom once it settles (CSS scales the old image meanwhile)
  const rawDpi = fitScale * renderZoom * 25.4 * window.devicePixelRatio;
  const dpi = Math.min(220, Math.max(36, Math.round(rawDpi / 5) * 5));

  useEffect(() => {
    const h = setTimeout(() => setRenderZoom(zoom), 220);
    return () => clearTimeout(h);
  }, [zoom]);

  useEffect(() => {
    if (!scroller.current) return;
    const ro = new ResizeObserver(([e]) => setViewport({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(scroller.current);
    return () => ro.disconnect();
  }, []);

  // ----- what invalidates the rendered pixels
  const profile = profiles.find((p) => p.id === project.printProfileId) ?? profiles[0];
  const ready = project.cards.every((c) => images[c.front]?.meta.decodable !== false);
  const contentKey = useMemo(
    () => JSON.stringify([project.cards, project.layout, project.printProfileId, profile, proof, gamut]),
    [project.cards, project.layout, project.printProfileId, profile, proof, gamut],
  );

  // ----- zoom anchored on a screen point
  const zoomTo = useCallback((next: number, clientX?: number, clientY?: number) => {
    const el = scroller.current;
    if (!el) return;
    const z0 = zoomRef.current;
    const z1 = clampZoom(next);
    if (Math.abs(z1 - z0) < 1e-4) return;
    const r = el.getBoundingClientRect();
    const cx = (clientX ?? r.left + r.width / 2) - r.left;
    const cy = (clientY ?? r.top + r.height / 2) - r.top;
    anchor.current = { x: el.scrollLeft + cx - PAD, y: el.scrollTop + cy - PAD, cx, cy, ratio: z1 / z0 };
    setZoom(z1);
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = null;
    el.scrollLeft = a.x * a.ratio + PAD - a.cx;
    el.scrollTop = a.y * a.ratio + PAD - a.cy;
  }, [zoom]);

  // ----- trackpad / mouse gestures
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let gestureBase: number | null = null;

    // Chromium / WebView2 / WebKitGTK: pinch arrives as wheel + ctrlKey; mouse Ctrl/⌘+wheel too.
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || gestureBase !== null) return;
      e.preventDefault();
      const dy = Math.max(-60, Math.min(60, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
      zoomTo(zoomRef.current * Math.exp(-dy * 0.01), e.clientX, e.clientY);
    };
    // WebKit (macOS WKWebView): pinch arrives as gesture events with a cumulative scale.
    type GestureEv = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureBase = zoomRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEv;
      if (gestureBase !== null) zoomTo(gestureBase * g.scale, g.clientX, g.clientY);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gestureBase = null;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, [zoomTo]);

  // drag to pan (mouse users; trackpads already pan with two fingers)
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent) => {
    const el = scroller.current!;
    if (e.button !== 0 && e.button !== 1) return;
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    drag.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const el = scroller.current!;
    el.scrollLeft = d.sl - (e.clientX - d.x);
    el.scrollTop = d.st - (e.clientY - d.y);
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  // keyboard zoom
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.target instanceof Element && e.target.closest("input, textarea, select"))) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomTo(zoomRef.current * 1.25);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomTo(zoomRef.current / 1.25);
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomTo]);

  // ----- current page from scroll position
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 2 - PAD;
    setCurrent(Math.min(Math.max(0, pages - 1), Math.max(0, Math.floor((mid + GAP / 2) / (pageH + GAP)))));
  };
  useEffect(onScroll, [pageH, pages]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = (i: number) => {
    const el = scroller.current;
    if (!el) return;
    const target = Math.min(pages - 1, Math.max(0, i));
    el.scrollTo({ top: target * (pageH + GAP), behavior: "smooth" });
  };

  const report = useCallback((delta: number, err?: string | null) => {
    setBusy((b) => Math.max(0, b + delta));
    if (err !== undefined) setError(err);
  }, []);

  const duplex = l.duplex.enabled;
  const isBack = pageMap[current]?.side === "back";

  // ----- click a card to open it, drag a copy onto another slot to move it
  const press = useRef<{ slot: SlotMap; x: number; y: number; id: number } | null>(null);
  const [ghost, setGhost] = useState<{ slot: SlotMap; x: number; y: number; target: number | null } | null>(null);
  const slotAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-instance]");
    return el ? Number(el.dataset.instance) : null;
  };
  const onSlotDown = (e: React.PointerEvent, slot: SlotMap) => {
    if (e.button !== 0) return; // middle button still pans
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    press.current = { slot, x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onSlotMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    if (!ghost && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
    setGhost({ slot: p.slot, x: e.clientX, y: e.clientY, target: slotAt(e.clientX, e.clientY) });
  };
  const onSlotUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (!ghost) {
      useApp.getState().openCard(p.slot.cardId);
      return;
    }
    const target = slotAt(e.clientX, e.clientY);
    setGhost(null);
    if (target !== null && target !== p.slot.instance) {
      useApp.getState().update((x) => ({ ...x, cards: moveInstance(x.cards, p.slot.instance, target) }));
    }
  };
  const onSlotCancel = () => {
    press.current = null;
    setGhost(null);
  };
  const slotHandlers = { onDown: onSlotDown, onMove: onSlotMove, onUp: onSlotUp, onCancel: onSlotCancel };
  const ghostCard = ghost ? project.cards.find((c) => c.id === ghost.slot.cardId) : undefined;
  const ghostImg = ghostCard ? images[ghostCard.front] : undefined;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-stage">
      <div
        ref={scroller}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => (zoom > 1.01 ? setZoom(1) : zoomTo(2, e.clientX, e.clientY))}
        className={cx("min-h-0 flex-1 overflow-auto overscroll-contain", dragging ? "cursor-grabbing" : zoom > 1.01 && "cursor-grab")}
      >
        <div className="flex w-max min-w-full flex-col items-center" style={{ padding: PAD, gap: GAP }}>
          {pages === 0 && (
            <div className="flex flex-col items-center gap-2 py-24 text-center text-fg-3" style={{ width: Math.max(pageW, 280) }}>
              <Layers size={22} />
              <p className="text-sm font-medium text-fg-2">{t("emptyDeckTitle")}</p>
              <p className="max-w-xs text-xs leading-relaxed">{t("emptyDeckBody")}</p>
            </div>
          )}
          {pageMap.map((pg, i) => (
            <PageView
              key={i}
              index={i}
              width={pageW}
              height={pageH}
              scale={scale}
              dpi={dpi}
              contentKey={contentKey}
              ready={ready}
              proof={proof}
              gamut={gamut}
              root={scroller}
              label={`${t("page")} ${i + 1}${duplex ? ` · ${pg.side === "back" ? t("backs") : t("fronts")}` : ""}`}
              report={report}
              slots={pg.slots}
              selected={selected}
              dragFrom={ghost?.slot.instance ?? null}
              dropTarget={ghost?.target ?? null}
              handlers={slotHandlers}
              names={project.cards}
            />
          ))}
        </div>
      </div>

      {ghost && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 -rotate-3 overflow-hidden rounded-[3px] shadow-2xl shadow-black/60 ring-2 ring-accent"
          style={{ left: ghost.x, top: ghost.y, width: ghost.slot.rect.w * scale * 0.6, height: ghost.slot.rect.h * scale * 0.6 }}
        >
          {ghostImg ? <img src={fileUrl(ghostImg.thumb)} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full bg-surface-3" />}
        </div>
      )}

      {error && (
        <div className="absolute top-3 left-1/2 flex max-w-xl -translate-x-1/2 items-center gap-2 rounded-md bg-bad/15 px-3 py-2 text-xs text-bad backdrop-blur">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-lg border border-line bg-surface/95 px-2 py-1.5 shadow-xl shadow-black/40 backdrop-blur">
        <IconButton icon={ChevronLeft} label="Previous page" disabled={current <= 0} onClick={() => goTo(current - 1)} />
        <span className="min-w-[104px] text-center font-mono text-xs font-medium">
          {t("page")} {pages ? current + 1 : 0} {t("of")} {pages}
        </span>
        <IconButton icon={ChevronRight} label="Next page" disabled={current >= pages - 1} onClick={() => goTo(current + 1)} />
        {duplex && <span className="px-1.5 text-[11px] text-fg-3">{isBack ? t("backs") : t("fronts")}</span>}
        <div className="mx-1.5 h-[18px] w-px bg-line" />
        <button
          onClick={() => setProof(!proof)}
          aria-pressed={proof}
          className={cx("flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold whitespace-nowrap", proof ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2")}
        >
          <Eye size={14} /> {t("softProof")}
        </button>
        {proof && (
          <button
            onClick={() => setGamut(!gamut)}
            aria-pressed={gamut}
            className={cx("h-7 rounded-md px-2 text-[11px] font-medium", gamut ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2")}
          >
            {t("gamut")}
          </button>
        )}
        <div className="mx-1.5 h-[18px] w-px bg-line" />
        <IconButton icon={ZoomOut} label="Zoom out (⌘−)" disabled={zoom <= MIN_ZOOM} onClick={() => zoomTo(zoom / 1.25)} />
        <span className="w-12 text-center font-mono text-xs text-fg-2">{Math.round(zoom * 100)}%</span>
        <IconButton icon={ZoomIn} label="Zoom in (⌘+)" disabled={zoom >= MAX_ZOOM} onClick={() => zoomTo(zoom * 1.25)} />
        <IconButton icon={Maximize} label="Fit page (⌘0)" onClick={() => setZoom(1)} />
        <span className="flex w-5 justify-center">{busy > 0 && <Loader2 size={14} className="animate-spin text-accent" />}</span>
        <div className="mx-1.5 h-[18px] w-px bg-line" />
        <button
          onClick={() => useApp.getState().setFocus(!focus)}
          aria-pressed={focus}
          title={focus ? `${t("exitFocus")} (Esc)` : `${t("focusMode")} (F)`}
          className={cx("flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold whitespace-nowrap", focus ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2")}
        >
          {focus ? <Minimize2 size={14} /> : <Maximize2 size={14} />} {focus ? t("exitFocus") : t("focusMode")}
        </button>
      </div>
    </div>
  );
}

interface SlotHandlers {
  onDown: (e: React.PointerEvent, slot: SlotMap) => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: (e: React.PointerEvent) => void;
  onCancel: () => void;
}

interface PageProps {
  index: number;
  width: number;
  height: number;
  /** px per mm */
  scale: number;
  slots: SlotMap[];
  selected: string | null;
  dragFrom: number | null;
  dropTarget: number | null;
  handlers: SlotHandlers;
  names: { id: string; name: string }[];
  dpi: number;
  contentKey: string;
  ready: boolean;
  proof: boolean;
  gamut: boolean;
  root: React.RefObject<HTMLDivElement | null>;
  label: string;
  report: (delta: number, err?: string | null) => void;
}

const PageView = memo(function PageView({ index, width, height, scale, slots, selected, dragFrom, dropTarget, handlers, names, dpi, contentKey, ready, proof, gamut, root, label, report }: PageProps) {
  const el = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const seq = useRef(0);
  const shown = useRef({ seq: 0, dpi: 0 });
  const rendered = useRef<{ key: string; dpi: number } | null>(null);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { root: root.current, rootMargin: "600px" });
    io.observe(node);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  useEffect(() => {
    if (!visible || !ready) return;
    const last = rendered.current;
    if (last && last.key === contentKey && last.dpi === dpi) return;
    const my = ++seq.current;
    const contentChanged = !last || last.key !== contentKey;

    const pass = async (d: number) => {
      const project = useApp.getState().project;
      if (!project || my !== seq.current) return;
      report(1);
      try {
        const r = await api.renderPreview(project, index, d, proof, gamut);
        if (my !== seq.current) return report(-1);
        // never let a late low-res pass replace the sharp image of the same edit
        if (!(shown.current.seq === my && shown.current.dpi > d)) {
          shown.current = { seq: my, dpi: d };
          setUrl(URL.createObjectURL(r.png));
        }
        report(-1, null);
      } catch (e) {
        report(-1, my === seq.current ? errorText(e) : undefined);
      }
    };

    const timers: ReturnType<typeof setTimeout>[] = [];
    if (contentChanged) {
      // instant low-res feedback, then the sharp pass once edits pause
      timers.push(setTimeout(() => pass(Math.min(QUICK_DPI, dpi)), 0));
      timers.push(setTimeout(() => pass(dpi).then(() => (rendered.current = { key: contentKey, dpi })), 260));
    } else {
      timers.push(setTimeout(() => pass(dpi).then(() => (rendered.current = { key: contentKey, dpi })), 60));
    }
    return () => timers.forEach(clearTimeout);
  }, [visible, ready, contentKey, dpi, index, proof, gamut, report]);

  return (
    <div ref={el} className="relative shrink-0 bg-paper shadow-2xl shadow-black/50" style={{ width, height }} aria-label={label}>
      {url && <img src={url} alt={label} draggable={false} className="pointer-events-none absolute inset-0 h-full w-full select-none" />}
      {slots.map((s) => {
        const name = names.find((n) => n.id === s.cardId)?.name ?? "";
        const isSel = s.cardId === selected;
        const isTarget = dropTarget === s.instance && dragFrom !== s.instance;
        return (
          <button
            key={s.instance}
            type="button"
            data-instance={s.instance}
            aria-label={name}
            title={name}
            onPointerDown={(e) => handlers.onDown(e, s)}
            onPointerMove={handlers.onMove}
            onPointerUp={handlers.onUp}
            onPointerCancel={handlers.onCancel}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && useApp.getState().openCard(s.cardId)}
            className={cx(
              "absolute cursor-pointer touch-none rounded-[2px] outline-none transition-[box-shadow,background-color,opacity] duration-100",
              "hover:shadow-[inset_0_0_0_2px_var(--color-accent)] focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]",
              isSel && "shadow-[inset_0_0_0_2px_var(--color-accent)]",
              isTarget && "bg-accent/25 shadow-[inset_0_0_0_2px_var(--color-accent)]",
              dragFrom === s.instance && "bg-black/45",
            )}
            style={{ left: s.rect.x * scale, top: s.rect.y * scale, width: s.rect.w * scale, height: s.rect.h * scale }}
          />
        );
      })}
      <span className="pointer-events-none absolute -top-5 left-0 text-[10px] font-medium text-fg-3">{label}</span>
    </div>
  );
});
