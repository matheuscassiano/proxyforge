// Asset ids understood by the builder renderer:
//   <library id>          image in the Rust image library (art, imported frames)
//   pack:<pack>/<path>    file from an asset pack, downloaded on first use (frames, symbols)
//   url:<https://…>       remote asset from an allow-listed host, cached by Rust (set symbols, scans)
// Bytes always come through Rust, so the canvas stays untainted and can be exported.
import { invoke } from "@tauri-apps/api/core";

export type Source = ImageBitmap | HTMLCanvasElement | HTMLImageElement;

export const packAsset = (pack: string, path: string) => `pack:${pack}/${path}`;
export const urlAsset = (url: string) => `url:${url}`;
export const isPackAsset = (id: string) => id.startsWith("pack:");

export function splitPack(id: string): { pack: string; path: string } | null {
  if (!id.startsWith("pack:")) return null;
  const rest = id.slice(5);
  const i = rest.indexOf("/");
  return i > 0 ? { pack: rest.slice(0, i), path: rest.slice(i + 1) } : null;
}

const toBuffer = (raw: ArrayBuffer | number[]) => (raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer);

export async function assetBytes(id: string): Promise<ArrayBuffer> {
  const pack = splitPack(id);
  if (pack) return toBuffer(await invoke<ArrayBuffer | number[]>("read_pack_file", pack));
  if (id.startsWith("url:")) return toBuffer(await invoke<ArrayBuffer | number[]>("fetch_asset", { url: id.slice(4) }));
  return toBuffer(await invoke<ArrayBuffer | number[]>("read_image", { id }));
}

function looksLikeSvg(buf: ArrayBuffer) {
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(512, buf.byteLength))).trimStart();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")) || head.startsWith("<!--");
}

/** SVGs are rasterised once at a print-friendly size (WebKit draws SVG images at their intrinsic size). */
async function rasterSvg(buf: ArrayBuffer, longSide = 2048): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([buf], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    let w = img.naturalWidth || 0;
    let h = img.naturalHeight || 0;
    if (!w || !h) {
      const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(new TextDecoder().decode(buf));
      w = vb ? Number(vb[1]) : 512;
      h = vb ? Number(vb[2]) : 512;
    }
    const s = longSide / Math.max(w, h);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function decodeAsset(buf: ArrayBuffer): Promise<Source> {
  if (looksLikeSvg(buf)) return rasterSvg(buf);
  return createImageBitmap(new Blob([buf]));
}

export const sourceSize = (s: Source) => ({ w: (s as ImageBitmap).width, h: (s as ImageBitmap).height });
