// Layer factories in card-fraction coordinates (0..1 of the trim box), as frame packs define them.
import { PT_TO_MM } from "../render";
import { image, rect, text } from "../templates";
import type { ImageLayer, Layer, ShapeLayer, TextLayer } from "../types";
import type { Geo } from "./types";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function kit(g: Geo) {
  const X = (f: number) => g.bleed + f * g.width;
  const Y = (f: number) => g.bleed + f * g.height;
  const Wd = (f: number) => f * g.width;
  const Ht = (f: number) => f * g.height;
  /** Font size given as a fraction of the card height (Card Conjurer convention) → pt. */
  const pt = (f: number) => (f * g.height) / PT_TO_MM;
  const id = (slot: string) => `slot:${slot}`;

  return {
    X,
    Y,
    pt,
    /** Plain rectangle over the full bleed box. */
    bleed(slot: string, name: string, color: string): ShapeLayer {
      return { ...rect(name, 0, 0, g.width + 2 * g.bleed, g.height + 2 * g.bleed, { kind: "solid", color }), id: id(slot), slot, locked: true };
    },
    /** Image covering the whole trim box (frames are drawn this way). */
    frame(slot: string, name: string, asset: string, extra: Partial<ImageLayer> = {}): ImageLayer {
      return { ...image(name, X(0), Y(0), g.width, g.height, { imageId: asset, fit: "stretch", ...extra }), id: id(slot), slot, locked: true };
    },
    /** Same frame stretched over the bleed box, under the real one (extends border colours). */
    frameBleed(slot: string, asset: string): ImageLayer {
      return { ...image("Sangria da moldura", 0, 0, g.width + 2 * g.bleed, g.height + 2 * g.bleed, { imageId: asset, fit: "stretch" }), id: id(slot), slot, locked: true };
    },
    img(slot: string, name: string, b: Box, asset: string | null, extra: Partial<ImageLayer> = {}): ImageLayer {
      return { ...image(name, X(b.x), Y(b.y), Wd(b.w), Ht(b.h), { imageId: asset, ...extra }), id: id(slot), slot };
    },
    txt(slot: string, name: string, b: Box, content: string, sizeFrac: number, extra: Partial<TextLayer> = {}): TextLayer {
      return { ...text(name, X(b.x), Y(b.y), Wd(b.w), Ht(b.h), content, { size: pt(sizeFrac), ...extra }), id: id(slot), slot };
    },
    box(slot: string, name: string, b: Box, color: string, extra: Partial<ShapeLayer> = {}): ShapeLayer {
      return { ...rect(name, X(b.x), Y(b.y), Wd(b.w), Ht(b.h), { kind: "solid", color }, extra), id: id(slot), slot };
    },
  };
}

/** Drop falsy entries (optional layers). */
export const layers = (...xs: (Layer | null | undefined | false)[]): Layer[] => xs.filter((x): x is Layer => !!x);
