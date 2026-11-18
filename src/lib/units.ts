// Small pure helpers shared by panels (mirrors detect_bleed_mm in imaging.rs).

export function detectBleedMm(w: number, h: number, cw: number, ch: number): number {
  if (!w || !h) return 0;
  const r = w / h;
  if (Math.abs(1 - r) < 1e-4) return 0;
  const b = (r * ch - cw) / (2 * (1 - r));
  if (b < 0.4 || b > 8) return 0;
  const snaps = [1, 2, 3, 3.175, 3.5, 4, 5];
  const best = snaps.reduce((a, c) => (Math.abs(b - c) < Math.abs(b - a) ? c : a));
  return Math.abs(b - best) < 0.12 ? best : Math.round(b * 10) / 10;
}

/** DPI the artwork reaches over the trimmed card width. */
export function artDpi(pxWidth: number, cardWidthMm: number, builtinBleedMm: number): number {
  if (!pxWidth) return 0;
  return Math.round(pxWidth / ((cardWidthMm + 2 * builtinBleedMm) / 25.4));
}

export const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Rough uncompressed size of a PDF export, for the estimate in the export dialog. */
export function estimateExportBytes(uniqueImages: number, cardW: number, cardH: number, bleed: number, dpi: number, cmyk: boolean, jpeg: boolean) {
  const px = ((cardW + 2 * bleed) / 25.4) * dpi * (((cardH + 2 * bleed) / 25.4) * dpi);
  const raw = px * (cmyk ? 4 : 3) * uniqueImages;
  return Math.round(raw * (jpeg ? 0.12 : 0.55));
}
