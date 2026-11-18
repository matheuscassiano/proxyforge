import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRightLeft, Check, ChevronLeft, ChevronRight, Copy, Eye, FileStack, Layers, Loader2, Maximize, Maximize2, Minimize2, Search, SquareDashed, SquareMousePointer, Trash2, X, ZoomIn, ZoomOut } from "lucide-react";
import { useUpscaleQueue } from "../lib/autoUpscale";
import { cardDpi, useApp } from "../lib/store";
import { detectBleedMm } from "../lib/units";
import { useT } from "../lib/i18n";
import { api, errorText, fileUrl } from "../lib/ipc";
import { moveInstance, moveInstances, removeInstances } from "../lib/deck";
import type { Margins, SlotMap } from "../lib/types";
import { usePageMap } from "./usePageMap";
import { cx, IconButton } from "./ui";

const DRAG_THRESHOLD = 4; // px before a press on a card becomes a drag

const PAD = 32; // stage padding (px)
const GAP = 24; // gap between pages (px)
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const QUICK_DPI = 30; // first, instant pass after an edit
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
/** Loupe: radius of the inspected region (mm) and of the lens on screen (px). */
const LENS_MM = 6;
const LENS_PX = 140;

/** Distance kept free of text/art inside the trim (common TCG safe area). */
const SAFE_MM = 3;

/** Screen-only overlays drawn on the preview (never exported). */
export interface Overlays {
  trim: boolean;
  bleed: boolean;
  safe: boolean;
  margins: boolean;
  /** Dim everything outside the trim, as the cards look after cutting. */
  cut: boolean;
}
const OVERLAY_KEY = "pf.stage.overlays";
const DEFAULT_OVERLAYS: Overlays = { trim: false, bleed: false, safe: false, margins: false, cut: false };
function loadOverlays(): Overlays {
  try {
    return { ...DEFAULT_OVERLAYS, ...JSON.parse(localStorage.getItem(OVERLAY_KEY) ?? "{}") };
  } catch {
    return DEFAULT_OVERLAYS;
  }
}

/** Geometry the overlays need, in mm. */
interface SheetGeo {
  pw: number;
  ph: number;
  bleed: number;
  radius: number;
  margins: Margins;
  rotation: number;
}

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
  const [overlays, setOverlaysState] = useState<Overlays>(loadOverlays);
  const [overlayMenu, setOverlayMenu] = useState(false);
  const setOverlays = (o: Overlays) => {
    setOverlaysState(o);
    try {
      localStorage.setItem(OVERLAY_KEY, JSON.stringify(o));
    } catch {
      /* private mode */
    }
  };
  const anyOverlay = Object.values(overlays).some(Boolean);
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
  const geo: SheetGeo = useMemo(
    () => ({ pw, ph, bleed: l.bleedMm, radius: l.cornerRadiusMm, margins: l.margins, rotation: l.rotationDeg ?? 0 }),
    [pw, ph, l.bleedMm, l.cornerRadiusMm, l.margins, l.rotationDeg],
  );
  // per-card info for the hover callout: effective print DPI of its artwork
  const cardInfo = useMemo(() => {
    const out: Record<string, { name: string; dpi: number }> = {};
    for (const c of project.cards) {
      const im = images[c.front];
      const b = c.builtinBleedMm ?? (im ? detectBleedMm(im.meta.width, im.meta.height, l.cardSize.width, l.cardSize.height) : 0);
      out[c.id] = { name: c.name, dpi: cardDpi(im?.meta, l.cardSize.width, b) };
    }
    return out;
  }, [project.cards, images, l.cardSize]);
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
  // auto-upscale: each finished image makes the preview re-render with the sharper art
  const upVersion = useUpscaleQueue((s) => s.version);
  const upKey = project.upscale?.auto ? `${project.upscale.model}|${project.upscale.maxScale}|${upVersion}` : "";
  const contentKey = useMemo(
    () => JSON.stringify([project.cards, project.layout, project.printProfileId, profile, proof, gamut, upKey]),
    [project.cards, project.layout, project.printProfileId, profile, proof, gamut, upKey],
  );

  // ----- loupe: a region under the cursor rendered at the print DPI
  const [loupe, setLoupe] = useState(false);
  const [lens, setLens] = useState<{ page: number; x: number; y: number; cx: number; cy: number } | null>(null);
  const [lensImg, setLensImg] = useState<string | null>(null);
  const lensSeq = useRef(0);
  const onLens = useCallback((page: number, e: React.MouseEvent<HTMLDivElement> | null) => {
    if (!e) return setLens(null);
    const r = e.currentTarget.getBoundingClientRect();
    const k = r.width / pw;
    setLens({ page, x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k, cx: e.clientX, cy: e.clientY });
  }, [pw]);
  const lensPage = lens?.page;
  const lensX = lens ? Math.round(lens.x * 4) / 4 : 0;
  const lensY = lens ? Math.round(lens.y * 4) / 4 : 0;
  useEffect(() => {
    if (!loupe || lensPage === undefined) return;
    const my = ++lensSeq.current;
    const h = setTimeout(async () => {
      const p = useApp.getState().project;
      if (!p) return;
      try {
        const blob = await api.renderRegion(p, lensPage, { x: lensX - LENS_MM, y: lensY - LENS_MM, w: 2 * LENS_MM, h: 2 * LENS_MM }, null, proof);
        if (my !== lensSeq.current) return;
        setLensImg((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
      } catch {
        /* outside the page */
      }
    }, 90);
    return () => clearTimeout(h);
  }, [loupe, lensPage, lensX, lensY, contentKey, proof]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]"))) return;
      if (e.key === "l" || e.key === "L") setLoupe((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    const inst = p.slot.instance;
    if (!ghost) {
      if (e.metaKey || e.ctrlKey) {
        setSel((prev) => {
          const next = new Set(prev);
          if (next.has(inst)) next.delete(inst);
          else next.add(inst);
          return next;
        });
        setSelAnchor(inst);
      } else if (e.shiftKey && selAnchor !== null) {
        const [a, b] = [Math.min(selAnchor, inst), Math.max(selAnchor, inst)];
        setSel((prev) => {
          const next = new Set(prev);
          for (let i = a; i <= b; i++) next.add(i);
          return next;
        });
      } else {
        setSel(new Set());
        useApp.getState().openCard(p.slot.cardId);
      }
      return;
    }
    const target = slotAt(e.clientX, e.clientY);
    setGhost(null);
    if (target === null || target === inst) return;
    if (sel.has(inst) && sel.size > 1) {
      moveSelectionTo(target);
    } else {
      useApp.getState().update((x) => ({ ...x, cards: moveInstance(x.cards, inst, target) }));
    }
  };

  // ----- selection, page checkboxes and the right-click menu
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [selAnchor, setSelAnchor] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; slot: SlotMap; pages: boolean } | null>(null);
  const frontPages = pageMap.filter((p) => p.side === "front");
  const perPage = Math.max(1, ...frontPages.map((p) => p.slots.length));
  /** Copies the menu acts on: the selection when the clicked copy is in it, else that copy. */
  const targets = (slot: SlotMap) => (sel.has(slot.instance) && sel.size > 0 ? [...sel] : [slot.instance]);
  const moveSelectionTo = (target: number, list?: number[]) => {
    const from = list ?? [...sel];
    const to = target - from.filter((i) => i < target).length;
    useApp.getState().update((x) => ({ ...x, cards: moveInstances(x.cards, from, to) }));
    setSel(new Set());
  };
  const moveToPage = (slot: SlotMap, page: number) => {
    const from = targets(slot);
    // the block starts exactly where that page starts once it is in place
    const start = (page - 1) * perPage;
    useApp.getState().update((x) => ({ ...x, cards: moveInstances(x.cards, from, start) }));
    setSel(new Set());
    setMenu(null);
  };
  const togglePage = (slots: SlotMap[]) =>
    setSel((prev) => {
      const all = slots.every((s) => prev.has(s.instance));
      const next = new Set(prev);
      for (const s of slots) {
        if (all) next.delete(s.instance);
        else next.add(s.instance);
      }
      return next;
    });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        setSel(new Set());
      }
    };
    const close = () => setMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", close);
    };
  }, []);
  // a deck edit can renumber copies: drop selections that no longer exist
  const totalCopies = project.cards.reduce((n, c) => n + c.qty, 0);
  useEffect(() => setSel((s) => (s.size && [...s].some((i) => i >= totalCopies) ? new Set() : s)), [totalCopies]);
  const onSlotCancel = () => {
    press.current = null;
    setGhost(null);
  };
  const onSlotMenu = (e: React.MouseEvent, slot: SlotMap) => {
    e.preventDefault();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 240), y: Math.min(e.clientY, window.innerHeight - 260), slot, pages: false });
  };
  const slotHandlers = { onDown: onSlotDown, onMove: onSlotMove, onUp: onSlotUp, onCancel: onSlotCancel, onMenu: onSlotMenu, onTogglePage: togglePage };
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
              selection={sel}
              info={cardInfo}
              overlays={overlays}
              geo={geo}
              cardLabel={`${l.cardSize.width}×${l.cardSize.height} mm · ${t("bleed")} ${l.bleedMm} mm`}
              onLens={loupe ? onLens : undefined}
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

      {menu && (
        <div
          role="menu"
          onPointerDown={(e) => e.stopPropagation()}
          className="fixed z-50 flex w-56 flex-col rounded-lg border border-line bg-surface p-1 text-xs shadow-xl shadow-black/50"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.pages ? (
            <>
              <span className="px-2 py-1.5 text-[11px] text-fg-3">{t("moveToPage")}</span>
              <div className="grid grid-cols-5 gap-1 p-1">
                {Array.from({ length: frontPages.length + 1 }, (_, i) => (
                  <button key={i} onClick={() => moveToPage(menu.slot, i + 1)} className="h-7 rounded bg-surface-2 font-mono hover:bg-accent-soft hover:text-accent">
                    {i + 1}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              {sel.size > 1 && sel.has(menu.slot.instance) && <span className="px-2 py-1.5 text-[11px] text-fg-3">{t("nSelected", { n: String(sel.size) })}</span>}
              <MenuItem icon={SquareMousePointer} label={t("openCard")} onClick={() => (useApp.getState().openCard(menu.slot.cardId), setMenu(null))} />
              <MenuItem icon={FileStack} label={`${t("moveToPage")}…`} onClick={() => setMenu({ ...menu, pages: true })} />
              {sel.size > 0 && !sel.has(menu.slot.instance) && (
                <MenuItem icon={ArrowRightLeft} label={t("moveSelectionHere")} onClick={() => (moveSelectionTo(menu.slot.instance), setMenu(null))} />
              )}
              <MenuItem
                icon={Copy}
                label={t("duplicateCopy")}
                onClick={() => {
                  useApp.getState().update((x) => ({ ...x, cards: x.cards.map((c) => (c.id === menu.slot.cardId ? { ...c, qty: c.qty + 1 } : c)) }));
                  setMenu(null);
                }}
              />
              <MenuItem
                icon={Trash2}
                danger
                label={targets(menu.slot).length > 1 ? t("removeCopies", { n: String(targets(menu.slot).length) }) : t("removeCopy")}
                onClick={() => {
                  const idx = targets(menu.slot);
                  useApp.getState().update((x) => ({ ...x, cards: removeInstances(x.cards, idx) }));
                  setSel(new Set());
                  setMenu(null);
                }}
              />
            </>
          )}
        </div>
      )}

      {sel.size > 0 && (
        <div className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-line bg-surface/95 px-3 py-1.5 text-xs shadow-xl shadow-black/40 backdrop-blur">
          <Check size={14} className="text-accent" />
          {t("nSelected", { n: String(sel.size) })}
          <span className="text-fg-3">· {t("selectionHint")}</span>
          <IconButton icon={X} label={t("clearSelection")} onClick={() => setSel(new Set())} />
        </div>
      )}

      {loupe && lens && (
        <div
          className="pointer-events-none fixed z-50 overflow-hidden rounded-full border-2 border-accent bg-paper shadow-2xl shadow-black/60"
          style={{ left: lens.cx - LENS_PX, top: lens.cy - LENS_PX, width: 2 * LENS_PX, height: 2 * LENS_PX }}
        >
          {lensImg && <img src={lensImg} alt="" className="h-full w-full" style={{ imageRendering: "auto" }} />}
          <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
            {profile?.dpi ?? 600} DPI · {(2 * LENS_MM).toFixed(0)} mm
          </span>
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
        <button
          onClick={() => setLoupe(!loupe)}
          aria-pressed={loupe}
          title={t("loupeHint")}
          className={cx("flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold whitespace-nowrap", loupe ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2")}
        >
          <Search size={14} /> {t("loupe")}
        </button>
        <div className="relative">
          <button
            onClick={() => setOverlayMenu(!overlayMenu)}
            aria-expanded={overlayMenu}
            className={cx("flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold whitespace-nowrap", anyOverlay ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2")}
          >
            <SquareDashed size={14} /> {t("viewOverlays")}
          </button>
          {overlayMenu && (
            <div className="absolute bottom-full left-1/2 mb-2 flex w-60 -translate-x-1/2 flex-col gap-1 rounded-lg border border-line bg-surface p-2 shadow-xl shadow-black/40">
              {(
                [
                  ["trim", "ovTrim", "#22d3ee"],
                  ["bleed", "ovBleed", "#f87171"],
                  ["safe", "ovSafe", "#4ade80"],
                  ["margins", "ovMargins", "#fb923c"],
                  ["cut", "ovCut", "#a1a1aa"],
                ] as const
              ).map(([k, label, color]) => (
                <label key={k} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-surface-2">
                  <input type="checkbox" checked={overlays[k]} onChange={(e) => setOverlays({ ...overlays, [k]: e.target.checked })} className="accent-[var(--color-accent)]" />
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
                  <span className="flex-1">{t(label)}</span>
                </label>
              ))}
              <p className="px-2 pt-1 text-[10px] leading-snug text-fg-3">{t("ovHint")}</p>
            </div>
          )}
        </div>
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
  onMenu: (e: React.MouseEvent, slot: SlotMap) => void;
  onTogglePage: (slots: SlotMap[]) => void;
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Copy; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} className={cx("flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2", danger && "text-bad")}>
      <Icon size={14} className={danger ? "" : "text-fg-3"} />
      {label}
    </button>
  );
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
  selection: Set<number>;
  info: Record<string, { name: string; dpi: number }>;
  overlays: Overlays;
  geo: SheetGeo;
  cardLabel: string;
  onLens?: (page: number, e: React.MouseEvent<HTMLDivElement> | null) => void;
  dpi: number;
  contentKey: string;
  ready: boolean;
  proof: boolean;
  gamut: boolean;
  root: React.RefObject<HTMLDivElement | null>;
  label: string;
  report: (delta: number, err?: string | null) => void;
}

const PageView = memo(function PageView({ index, width, height, scale, slots, selected, dragFrom, dropTarget, handlers, selection, info, overlays, geo, cardLabel, onLens, dpi, contentKey, ready, proof, gamut, root, label, report }: PageProps) {
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
    <div
      ref={el}
      className={cx("relative shrink-0 bg-paper shadow-2xl shadow-black/50", onLens && "cursor-crosshair")}
      style={{ width, height }}
      aria-label={label}
      onMouseMove={onLens ? (e) => onLens(index, e) : undefined}
      onMouseLeave={onLens ? () => onLens(index, null) : undefined}
    >
      <div className="pointer-events-none absolute inset-0" style={geo.rotation ? { transform: `rotate(${geo.rotation}deg)` } : undefined}>
        {url && <img src={url} alt={label} draggable={false} className="absolute inset-0 h-full w-full select-none" />}
        <SheetOverlay slots={slots} scale={scale} geo={geo} overlays={overlays} width={width} height={height} />
      </div>
      {slots.map((s) => {
        const ci = info[s.cardId];
        const name = ci?.name ?? "";
        const isSel = s.cardId === selected;
        const picked = selection.has(s.instance);
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
            onContextMenu={(e) => handlers.onMenu(e, s)}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && useApp.getState().openCard(s.cardId)}
            className={cx(
              "group absolute cursor-pointer touch-none rounded-[2px] outline-none transition-[box-shadow,background-color,opacity] duration-100",
              "hover:shadow-[inset_0_0_0_2px_var(--color-accent)] focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]",
              isSel && "shadow-[inset_0_0_0_2px_var(--color-accent)]",
              isTarget && "bg-accent/25 shadow-[inset_0_0_0_2px_var(--color-accent)]",
              picked && "bg-accent/20 shadow-[inset_0_0_0_3px_var(--color-accent)]",
              dragFrom === s.instance && "bg-black/45",
            )}
            style={{ left: s.rect.x * scale, top: s.rect.y * scale, width: s.rect.w * scale, height: s.rect.h * scale }}
          >
            <span className="pointer-events-none absolute inset-x-1 top-1 hidden flex-col gap-0.5 rounded bg-black/75 px-1.5 py-1 text-left text-[10px] leading-tight text-white group-hover:flex">
              <span className="truncate font-semibold">{name}</span>
              <span className="font-mono text-white/75">{cardLabel}</span>
              {ci && ci.dpi > 0 && <span className={cx("font-mono", ci.dpi < 300 ? "text-amber-300" : "text-white/75")}>{ci.dpi} DPI</span>}
            </span>
          </button>
        );
      })}
      <span className="pointer-events-none absolute -top-5 left-6 text-[10px] font-medium text-fg-3">{label}</span>
      {slots.length > 0 && (
        <input
          type="checkbox"
          aria-label={label}
          title={label}
          checked={slots.every((s) => selection.has(s.instance))}
          onChange={() => handlers.onTogglePage(slots)}
          onPointerDown={(e) => e.stopPropagation()}
          className={cx(
            "absolute -top-[22px] left-0 h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent)] transition-opacity",
            slots.some((s) => selection.has(s.instance)) ? "opacity-100" : "opacity-40 hover:opacity-100",
          )}
        />
      )}
    </div>
  );
});

/** Rounded-rect SVG path (mm → px). */
function rr(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r === 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`;
}

/** Screen-only guides over a rendered page: trim, bleed, safe area, margins, cut simulation. */
const SheetOverlay = memo(function SheetOverlay({ slots, scale, geo, overlays, width, height }: { slots: SlotMap[]; scale: number; geo: SheetGeo; overlays: Overlays; width: number; height: number }) {
  if (!Object.values(overlays).some(Boolean)) return null;
  const k = scale;
  const b = geo.bleed;
  const trims = slots.map((s) => rr(s.rect.x * k, s.rect.y * k, s.rect.w * k, s.rect.h * k, geo.radius * k)).join("");
  const dash = `${Math.max(3, 1.2 * k)} ${Math.max(2, 0.8 * k)}`;
  const m = geo.margins;
  return (
    <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
      <defs>
        <pattern id="pf-hatch" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={6} height={6} fill="rgba(248,113,113,0.18)" />
          <line x1={0} y1={0} x2={0} y2={6} stroke="rgba(248,113,113,0.65)" strokeWidth={2} />
        </pattern>
      </defs>
      {overlays.cut && <path d={`M0 0H${width}V${height}H0Z${trims}`} fillRule="evenodd" fill="rgba(9,9,11,0.82)" />}
      {overlays.margins && (
        <>
          <path
            d={`M0 0H${width}V${height}H0Z M${m.left * k} ${m.top * k}H${(geo.pw - m.right) * k}V${(geo.ph - m.bottom) * k}H${m.left * k}Z`}
            fillRule="evenodd"
            fill="rgba(251,146,60,0.12)"
          />
          <rect x={m.left * k} y={m.top * k} width={(geo.pw - m.left - m.right) * k} height={(geo.ph - m.top - m.bottom) * k} fill="none" stroke="#fb923c" strokeWidth={1} strokeDasharray="6 4" />
        </>
      )}
      {overlays.bleed &&
        b > 0 &&
        slots.map((s) => (
          <path
            key={`b${s.instance}`}
            d={`M${(s.rect.x - b) * k} ${(s.rect.y - b) * k}h${(s.rect.w + 2 * b) * k}v${(s.rect.h + 2 * b) * k}h${-(s.rect.w + 2 * b) * k}Z ${rr(s.rect.x * k, s.rect.y * k, s.rect.w * k, s.rect.h * k, geo.radius * k)}`}
            fillRule="evenodd"
            fill="url(#pf-hatch)"
          />
        ))}
      {overlays.safe &&
        slots.map((s) => (
          <path
            key={`s${s.instance}`}
            d={rr((s.rect.x + SAFE_MM) * k, (s.rect.y + SAFE_MM) * k, (s.rect.w - 2 * SAFE_MM) * k, (s.rect.h - 2 * SAFE_MM) * k, Math.max(0, geo.radius - SAFE_MM) * k)}
            fill="none"
            stroke="#4ade80"
            strokeWidth={1}
            strokeDasharray={dash}
          />
        ))}
      {overlays.trim && <path d={trims} fill="none" stroke="#22d3ee" strokeWidth={1.25} strokeDasharray={dash} />}
    </svg>
  );
});
