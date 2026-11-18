// Card builder document model. Units are millimetres from the top-left of the bleed box.
// Stored as-is in Project.designs (the Rust side treats it as opaque JSON).

export interface GradientStop {
  offset: number; // 0..1
  color: string; // #rrggbb or #rrggbbaa
}

export type Fill =
  | { kind: "none" }
  | { kind: "solid"; color: string }
  | { kind: "linear"; angle: number; stops: GradientStop[] }
  | { kind: "radial"; stops: GradientStop[] };

export interface Stroke {
  color: string;
  width: number; // mm
  dash?: number; // mm, 0 = solid
}

export interface Shadow {
  color: string;
  blur: number; // mm
  x: number; // mm
  y: number; // mm
}

export type BlendMode = "source-over" | "multiply" | "screen" | "overlay" | "soft-light" | "hard-light" | "color-dodge" | "color-burn" | "darken" | "lighten" | "difference" | "luminosity";

export interface BaseLayer {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number; // degrees, around the layer centre
  opacity: number; // 0..1
  visible: boolean;
  locked: boolean;
  blend: BlendMode;
  shadow: Shadow | null;
}

export interface ShapeLayer extends BaseLayer {
  kind: "rect" | "ellipse" | "polygon";
  fill: Fill;
  stroke: Stroke | null;
  radius: number; // mm, rect corners
  sides: number; // polygon: 3..12
  star: boolean; // polygon drawn as a star
}

export type ImageFit = "cover" | "contain" | "stretch";

export interface ImageFilters {
  brightness: number; // 1 = neutral
  contrast: number;
  saturate: number;
  hue: number; // degrees
  grayscale: number; // 0..1
  sepia: number; // 0..1
  blur: number; // mm
}

export interface ImageLayer extends BaseLayer {
  kind: "image";
  imageId: string | null;
  fit: ImageFit;
  zoom: number; // 1 = fitted
  offsetX: number; // -1..1, pan inside the frame
  offsetY: number;
  flipX: boolean;
  radius: number;
  stroke: Stroke | null;
  filters: ImageFilters;
}

export interface TextLayer extends BaseLayer {
  kind: "text";
  text: string; // supports **bold**, *italic*, {symbols} and new lines
  font: string;
  size: number; // pt
  weight: 400 | 700;
  italic: boolean;
  color: string;
  align: "left" | "center" | "right" | "justify";
  vAlign: "top" | "middle" | "bottom";
  lineHeight: number; // multiple of size
  letterSpacing: number; // em
  uppercase: boolean;
  autoFit: boolean; // shrink to fit the box
  stroke: Stroke | null; // outline
  background: Fill;
  padding: number; // mm
  radius: number;
}

export type Layer = ShapeLayer | ImageLayer | TextLayer;
export type LayerKind = Layer["kind"];

export interface CardDesign {
  id: string;
  name: string;
  /** Trim size of the card. */
  width: number;
  height: number;
  /** Bleed included in the rendered image, on every side. */
  bleed: number;
  /** Inner safe margin shown as a guide. */
  safe: number;
  layers: Layer[]; // bottom → top
  /** Another design used as this card's back (double-sided proxies). */
  backId: string | null;
  updatedAt: string;
}
