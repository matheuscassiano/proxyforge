// Canvas 2D renderer for card designs. Shared by the editor (live) and the exporter
// (high DPI PNG that goes into the image library and the print pipeline).
import { invoke } from "@tauri-apps/api/core";
import type { CardDesign, Fill, ImageFilters, ImageLayer, Layer, ShapeLayer, Stroke, TextLayer } from "./types";

export const PT_TO_MM = 25.4 / 72;
type Ctx = CanvasRenderingContext2D;
type Source = ImageBitmap | HTMLCanvasElement | HTMLImageElement;

// ------------------------------------------------------------------ images

const sources = new Map<string, Promise<Source>>();
const filtered = new Map<string, HTMLCanvasElement>();

/** Image bytes from the Rust library (keeps the canvas untainted for export). */
export function loadImage(id: string): Promise<Source> {
  let p = sources.get(id);
  if (!p) {
    p = (async () => {
      const raw = await invoke<ArrayBuffer | number[]>("read_image", { id });
      const buf = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer;
      return createImageBitmap(new Blob([buf]));
    })();
    p.catch(() => sources.delete(id));
    sources.set(id, p);
  }
  return p;
}

/** For tests / mock mode: register an already-decoded source. */
export function registerImage(id: string, src: Source) {
  sources.set(id, Promise.resolve(src));
}

export type Assets = Map<string, Source>;

export async function loadAssets(design: CardDesign): Promise<Assets> {
  const ids = design.layers.filter((l): l is ImageLayer => l.kind === "image" && !!l.imageId).map((l) => l.imageId!);
  const out: Assets = new Map();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      try {
        out.set(id, await loadImage(id));
      } catch {
        /* missing image: drawn as placeholder */
      }
    }),
  );
  return out;
}

const NEUTRAL: ImageFilters = { brightness: 1, contrast: 1, saturate: 1, hue: 0, grayscale: 0, sepia: 0, blur: 0 };
const isNeutral = (f: ImageFilters) =>
  f.brightness === 1 && f.contrast === 1 && f.saturate === 1 && f.hue === 0 && f.grayscale === 0 && f.sepia === 0;

/** Colour filters applied in JS (WebKit's canvas has no `ctx.filter`). Cached per image + settings. */
function applyFilters(id: string, src: Source, f: ImageFilters): Source {
  if (isNeutral(f)) return src;
  const key = `${id}|${f.brightness}|${f.contrast}|${f.saturate}|${f.hue}|${f.grayscale}|${f.sepia}`;
  const hit = filtered.get(key);
  if (hit) return hit;
  const w = (src as ImageBitmap).width;
  const h = (src as ImageBitmap).height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.drawImage(src, 0, 0);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const rad = (f.hue * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // hue rotation matrix (same as CSS hue-rotate)
  const m = [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
  ];
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] / 255;
    let gg = d[i + 1] / 255;
    let b = d[i + 2] / 255;
    r *= f.brightness; gg *= f.brightness; b *= f.brightness;
    r = (r - 0.5) * f.contrast + 0.5; gg = (gg - 0.5) * f.contrast + 0.5; b = (b - 0.5) * f.contrast + 0.5;
    const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    r = l + (r - l) * f.saturate; gg = l + (gg - l) * f.saturate; b = l + (b - l) * f.saturate;
    if (f.hue) {
      const [r2, g2, b2] = [m[0] * r + m[1] * gg + m[2] * b, m[3] * r + m[4] * gg + m[5] * b, m[6] * r + m[7] * gg + m[8] * b];
      r = r2; gg = g2; b = b2;
    }
    if (f.grayscale) {
      const y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      r += (y - r) * f.grayscale; gg += (y - gg) * f.grayscale; b += (y - b) * f.grayscale;
    }
    if (f.sepia) {
      const sr = 0.393 * r + 0.769 * gg + 0.189 * b;
      const sg = 0.349 * r + 0.686 * gg + 0.168 * b;
      const sb = 0.272 * r + 0.534 * gg + 0.131 * b;
      r += (sr - r) * f.sepia; gg += (sg - gg) * f.sepia; b += (sb - b) * f.sepia;
    }
    d[i] = r * 255; d[i + 1] = gg * 255; d[i + 2] = b * 255;
  }
  g.putImageData(img, 0, 0);
  if (filtered.size > 24) filtered.delete(filtered.keys().next().value!);
  filtered.set(key, c);
  return c;
}

let canvasFilterSupport: boolean | null = null;
function supportsCanvasFilter(ctx: Ctx) {
  if (canvasFilterSupport === null) {
    const prev = ctx.filter;
    ctx.filter = "blur(1px)";
    canvasFilterSupport = ctx.filter === "blur(1px)";
    ctx.filter = prev ?? "none";
  }
  return canvasFilterSupport;
}

// ------------------------------------------------------------------ paths & paint

function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function shapePath(ctx: Ctx, l: ShapeLayer, w: number, h: number, k: number) {
  if (l.kind === "rect") return roundRectPath(ctx, 0, 0, w, h, l.radius * k);
  if (l.kind === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return;
  }
  const n = Math.max(3, Math.min(24, Math.round(l.sides)));
  const pts = l.star ? n * 2 : n;
  ctx.beginPath();
  for (let i = 0; i < pts; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / pts;
    const f = l.star && i % 2 ? 0.45 : 1;
    const px = w / 2 + (Math.cos(a) * w * f) / 2;
    const py = h / 2 + (Math.sin(a) * h * f) / 2;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
}

function paint(ctx: Ctx, fill: Fill, w: number, h: number): string | CanvasGradient | null {
  switch (fill.kind) {
    case "none":
      return null;
    case "solid":
      return fill.color;
    case "linear": {
      const a = ((fill.angle - 90) * Math.PI) / 180;
      const len = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
      const dx = (Math.cos(a) * len) / 2;
      const dy = (Math.sin(a) * len) / 2;
      const g = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
      fill.stops.forEach((s) => g.addColorStop(Math.min(1, Math.max(0, s.offset)), s.color));
      return g;
    }
    case "radial": {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
      fill.stops.forEach((s) => g.addColorStop(Math.min(1, Math.max(0, s.offset)), s.color));
      return g;
    }
  }
}

function applyStroke(ctx: Ctx, s: Stroke | null, k: number) {
  if (!s || s.width <= 0) return;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width * k;
  ctx.setLineDash(s.dash ? [s.dash * k, s.dash * k] : []);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ------------------------------------------------------------------ rich text

export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  symbol?: boolean;
  newline?: boolean;
}

/** `**bold**`, `*italic*`, `{R}` symbols and line breaks. */
export function parseRich(src: string): Run[] {
  const out: Run[] = [];
  let bold = false;
  let italic = false;
  let buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf, bold, italic });
    buf = "";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\n") {
      flush();
      out.push({ text: "", bold, italic, newline: true });
    } else if (c === "*" && src[i + 1] === "*") {
      flush();
      bold = !bold;
      i++;
    } else if (c === "*") {
      flush();
      italic = !italic;
    } else if (c === "{") {
      const end = src.indexOf("}", i);
      if (end > i && end - i <= 8) {
        flush();
        out.push({ text: src.slice(i + 1, end), bold, italic, symbol: true });
        i = end;
      } else buf += c;
    } else buf += c;
  }
  flush();
  return out;
}

const SYMBOL_COLORS: Record<string, string> = {
  W: "#f8f6d8",
  U: "#c1d7e9",
  B: "#bab1ab",
  R: "#e49977",
  G: "#a3c095",
  C: "#cac5c0",
  E: "#f2d27a",
  S: "#d7e6ee",
};

interface Piece {
  kind: "word" | "space" | "symbol";
  text: string;
  bold: boolean;
  italic: boolean;
  width: number;
}

interface Line {
  pieces: Piece[];
  width: number;
  last: boolean; // last line of a paragraph (no justify)
}

function fontCss(t: TextLayer, bold: boolean, italic: boolean, px: number) {
  const w = bold ? 700 : t.weight;
  return `${italic || t.italic ? "italic " : ""}${w} ${px}px "${t.font}", serif`;
}

function measure(ctx: Ctx, text: string, spacingPx: number) {
  return ctx.measureText(text).width + spacingPx * text.length;
}

function layoutText(ctx: Ctx, t: TextLayer, px: number, maxW: number) {
  const spacing = t.letterSpacing * px;
  const runs = parseRich(t.uppercase ? t.text.toUpperCase() : t.text);
  const lines: Line[] = [];
  let cur: Piece[] = [];
  let curW = 0;
  const symW = px * 0.92;
  const pushLine = (last: boolean) => {
    while (cur.length && cur[cur.length - 1].kind === "space") curW -= cur.pop()!.width;
    lines.push({ pieces: cur, width: curW, last });
    cur = [];
    curW = 0;
  };
  for (const r of runs) {
    if (r.newline) {
      pushLine(true);
      continue;
    }
    const parts: Piece[] = [];
    if (r.symbol) parts.push({ kind: "symbol", text: r.text, bold: r.bold, italic: r.italic, width: symW + px * 0.08 });
    else {
      ctx.font = fontCss(t, r.bold, r.italic, px);
      for (const tok of r.text.split(/(\s+)/)) {
        if (!tok) continue;
        const space = /^\s+$/.test(tok);
        parts.push({ kind: space ? "space" : "word", text: space ? " " : tok, bold: r.bold, italic: r.italic, width: measure(ctx, space ? " " : tok, spacing) });
      }
    }
    for (const p of parts) {
      if (p.kind === "space" && cur.length === 0) continue;
      if (p.kind !== "space" && curW + p.width > maxW && cur.length) pushLine(false);
      cur.push(p);
      curW += p.width;
    }
  }
  pushLine(true);
  const tooWide = lines.some((l) => l.width > maxW + 0.5);
  return { lines, tooWide };
}

function drawText(ctx: Ctx, t: TextLayer, w: number, h: number, k: number) {
  const pad = t.padding * k;
  const bg = paint(ctx, t.background, w, h);
  if (bg) {
    roundRectPath(ctx, 0, 0, w, h, t.radius * k);
    ctx.fillStyle = bg;
    ctx.fill();
  }
  const maxW = Math.max(1, w - 2 * pad);
  const maxH = Math.max(1, h - 2 * pad);
  let sizePt = t.size;
  let px = sizePt * PT_TO_MM * k;
  let lay = layoutText(ctx, t, px, maxW);
  const total = (l: { lines: Line[] }) => l.lines.length * px * t.lineHeight;
  if (t.autoFit) {
    while ((total(lay) > maxH || lay.tooWide) && sizePt > 4) {
      sizePt -= 0.25;
      px = sizePt * PT_TO_MM * k;
      lay = layoutText(ctx, t, px, maxW);
    }
  }
  const lh = px * t.lineHeight;
  const blockH = lay.lines.length * lh;
  let y = pad + (t.vAlign === "middle" ? (maxH - blockH) / 2 : t.vAlign === "bottom" ? maxH - blockH : 0);
  const spacing = t.letterSpacing * px;
  ctx.textBaseline = "alphabetic";
  for (const line of lay.lines) {
    const baseline = y + lh / 2 + px * 0.34;
    const spaces = line.pieces.filter((p) => p.kind === "space").length;
    const justify = t.align === "justify" && !line.last && spaces > 0;
    const extra = justify ? (maxW - line.width) / spaces : 0;
    let x = pad + (t.align === "center" ? (maxW - line.width) / 2 : t.align === "right" ? maxW - line.width : 0);
    for (const p of line.pieces) {
      if (p.kind === "space") {
        x += p.width + extra;
        continue;
      }
      if (p.kind === "symbol") {
        drawSymbol(ctx, p.text, x + px * 0.04, baseline - px * 0.36, px * 0.92, t);
        x += p.width;
        continue;
      }
      ctx.font = fontCss(t, p.bold, p.italic, px);
      const drawAt = (fn: (s: string, x: number, y: number) => void) => {
        if (!spacing) fn(p.text, x, baseline);
        else {
          let cx = x;
          for (const ch of p.text) {
            fn(ch, cx, baseline);
            cx += ctx.measureText(ch).width + spacing;
          }
        }
      };
      if (t.stroke && t.stroke.width > 0) {
        ctx.save();
        ctx.shadowColor = "transparent";
        ctx.strokeStyle = t.stroke.color;
        ctx.lineWidth = t.stroke.width * k * 2;
        ctx.lineJoin = "round";
        drawAt((s, a, b) => ctx.strokeText(s, a, b));
        ctx.restore();
      }
      ctx.fillStyle = t.color;
      drawAt((s, a, b) => ctx.fillText(s, a, b));
      x += p.width;
    }
    y += lh;
  }
}

function drawSymbol(ctx: Ctx, sym: string, x: number, cy: number, d: number, t: TextLayer) {
  const key = sym.toUpperCase();
  const fill = SYMBOL_COLORS[key] ?? (/^\d+$|^X$/.test(key) ? SYMBOL_COLORS.C : "#d4d4d8");
  ctx.save();
  ctx.shadowColor = "transparent";
  ctx.beginPath();
  ctx.arc(x + d / 2, cy, d / 2, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = Math.max(0.5, d * 0.06);
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.stroke();
  const label = key === "T" ? "↷" : key;
  ctx.fillStyle = "#111";
  ctx.font = `700 ${d * (label.length > 1 ? 0.5 : 0.62)}px "${t.font}", serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + d / 2, cy + d * 0.03);
  ctx.restore();
}

// ------------------------------------------------------------------ image layer

function drawImage(ctx: Ctx, l: ImageLayer, w: number, h: number, k: number, assets: Assets, editor: boolean) {
  roundRectPath(ctx, 0, 0, w, h, l.radius * k);
  const src = l.imageId ? assets.get(l.imageId) : undefined;
  ctx.save();
  ctx.clip();
  if (!src) {
    ctx.fillStyle = editor ? "#3f3f46" : "#808080";
    ctx.fillRect(0, 0, w, h);
    if (editor) {
      ctx.strokeStyle = "#52525b";
      ctx.lineWidth = 1;
      for (let i = -h; i < w; i += 12) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + h, h);
        ctx.stroke();
      }
    }
  } else {
    const s = applyFilters(l.imageId!, src, l.filters);
    const iw = (s as ImageBitmap).width;
    const ih = (s as ImageBitmap).height;
    let dw: number;
    let dh: number;
    if (l.fit === "stretch") {
      dw = w * l.zoom;
      dh = h * l.zoom;
    } else {
      const sc = (l.fit === "cover" ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih)) * l.zoom;
      dw = iw * sc;
      dh = ih * sc;
    }
    const dx = (w - dw) / 2 + (l.offsetX * Math.abs(dw - w)) / 2;
    const dy = (h - dh) / 2 + (l.offsetY * Math.abs(dh - h)) / 2;
    if (l.filters.blur > 0 && supportsCanvasFilter(ctx)) ctx.filter = `blur(${l.filters.blur * k}px)`;
    if (l.flipX) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(s, l.flipX ? w - dx - dw : dx, dy, dw, dh);
  }
  ctx.restore();
  roundRectPath(ctx, 0, 0, w, h, l.radius * k);
  applyStroke(ctx, l.stroke, k);
}

// ------------------------------------------------------------------ design

export function drawLayer(ctx: Ctx, l: Layer, k: number, assets: Assets, editor = false) {
  if (!l.visible || l.opacity <= 0) return;
  const w = l.w * k;
  const h = l.h * k;
  ctx.save();
  ctx.globalAlpha = l.opacity;
  ctx.globalCompositeOperation = l.blend ?? "source-over";
  ctx.translate(l.x * k + w / 2, l.y * k + h / 2);
  ctx.rotate((l.rotation * Math.PI) / 180);
  ctx.translate(-w / 2, -h / 2);
  if (l.shadow) {
    ctx.shadowColor = l.shadow.color;
    ctx.shadowBlur = l.shadow.blur * k;
    ctx.shadowOffsetX = l.shadow.x * k;
    ctx.shadowOffsetY = l.shadow.y * k;
  }
  if (l.kind === "text") drawText(ctx, l, w, h, k);
  else if (l.kind === "image") drawImage(ctx, l, w, h, k, assets, editor);
  else {
    shapePath(ctx, l, w, h, k);
    const p = paint(ctx, l.fill, w, h);
    if (p) {
      ctx.fillStyle = p;
      ctx.fill();
    }
    ctx.shadowColor = "transparent";
    applyStroke(ctx, l.stroke, k);
  }
  ctx.restore();
}

export function renderDesign(ctx: Ctx, d: CardDesign, k: number, assets: Assets, editor = false) {
  const W = (d.width + 2 * d.bleed) * k;
  const H = (d.height + 2 * d.bleed) * k;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  for (const l of d.layers) drawLayer(ctx, l, k, assets, editor);
  ctx.restore();
}

/** Render to a PNG Blob at `dpi` (bleed included). Large DPIs are capped by canvas limits. */
export async function exportPng(d: CardDesign, dpi: number): Promise<Blob> {
  const { ensureFonts } = await import("./fonts");
  await ensureFonts(d.layers.filter((l): l is TextLayer => l.kind === "text").map((t) => ({ font: t.font, weight: t.weight, italic: t.italic })));
  const assets = await loadAssets(d);
  const maxSide = 12000;
  const k0 = dpi / 25.4;
  const W0 = (d.width + 2 * d.bleed) * k0;
  const H0 = (d.height + 2 * d.bleed) * k0;
  const k = k0 * Math.min(1, maxSide / Math.max(W0, H0));
  const c = document.createElement("canvas");
  c.width = Math.round((d.width + 2 * d.bleed) * k);
  c.height = Math.round((d.height + 2 * d.bleed) * k);
  renderDesign(c.getContext("2d")!, d, k, assets, false);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("PNG encoding failed"))), "image/png"));
}

export { NEUTRAL as NEUTRAL_FILTERS };
