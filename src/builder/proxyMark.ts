// The "PROXY · NOT FOR SALE" mark drawn on every card the builder renders (editor, thumbnails,
// PNG export, deck). It is not a layer and has no off switch: only its edge, opacity (≥ 0.5)
// and size (≥ 1.6 mm) can change, and it always sits inside the trim box so it survives cutting.
import type { CardDesign, ProxyMark } from "./types";

export const PROXY_TEXT = "PROXY · NOT FOR SALE";
export const MIN_OPACITY = 0.5;
export const MIN_SIZE_MM = 1.6;
export const DEFAULT_MARK: ProxyMark = { position: "bottom", opacity: 0.85, size: 1.8 };

/** The subset of CanvasRenderingContext2D the mark needs (kept small so tests can fake it). */
export interface MarkCtx {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  measureText(t: string): { width: number };
  fillText(t: string, x: number, y: number): void;
  strokeText(t: string, x: number, y: number): void;
  globalAlpha: number;
  globalCompositeOperation: string;
  font: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  textAlign: string;
  textBaseline: string;
  shadowColor: string;
  letterSpacing?: string;
}

export function effectiveMark(d: Pick<CardDesign, "proxyMark">): ProxyMark {
  const m = { ...DEFAULT_MARK, ...(d.proxyMark ?? {}) };
  const position = (["bottom", "top", "left", "right"] as const).includes(m.position) ? m.position : "bottom";
  const opacity = Number.isFinite(m.opacity) ? Math.min(1, Math.max(MIN_OPACITY, m.opacity)) : DEFAULT_MARK.opacity;
  const size = Number.isFinite(m.size) ? Math.min(4, Math.max(MIN_SIZE_MM, m.size)) : DEFAULT_MARK.size;
  const inset = Number.isFinite(m.inset) ? Math.min(6, Math.max(0.4, m.inset!)) : Math.max(1.2, Math.min(2.2, size * 0.9));
  return { position, opacity, size, inset };
}

/** Draw the mark. `k` = pixels per mm; geometry is in mm from the top-left of the bleed box. */
export function drawProxyMark(ctx: MarkCtx, d: Pick<CardDesign, "width" | "height" | "bleed" | "proxyMark">, k: number) {
  const m = effectiveMark(d);
  const px = m.size * k;
  const inset = m.inset! * k; // from the trim edge, inside the card
  const x0 = d.bleed * k;
  const y0 = d.bleed * k;
  const w = d.width * k;
  const h = d.height * k;
  ctx.save();
  ctx.globalAlpha = m.opacity;
  ctx.globalCompositeOperation = "source-over";
  ctx.shadowColor = "transparent";
  ctx.font = `700 ${px}px "Inter Variable", "Montserrat", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let cx = x0 + w / 2;
  let cy = y0 + h - inset - px / 2;
  let angle = 0;
  if (m.position === "top") cy = y0 + inset + px / 2;
  if (m.position === "left" || m.position === "right") {
    cy = y0 + h / 2;
    cx = m.position === "left" ? x0 + inset + px / 2 : x0 + w - inset - px / 2;
    angle = m.position === "left" ? -Math.PI / 2 : Math.PI / 2;
  }
  ctx.translate(cx, cy);
  if (angle) ctx.rotate(angle);
  // Dark outline + light fill reads on any background.
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, px * 0.28);
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(PROXY_TEXT, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(PROXY_TEXT, 0, 0);
  ctx.restore();
}
