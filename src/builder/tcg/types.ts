// A TCG profile turns structured card fields into builder layers, like Card Conjurer /
// pokecardmaker do. Layers it returns carry a `slot`, so canvas edits can be kept as overrides.
import type { FieldValue, Layer, RealMask, TcgState } from "../types";

export type TcgId = TcgState["game"];

/** Localised string. */
export interface L {
  en: string;
  pt: string;
}

export interface Option {
  value: string;
  label: L;
}

export interface FieldDef {
  key: string;
  label: L;
  kind: "text" | "rich" | "number" | "select" | "cost" | "toggle" | "image" | "list" | "set";
  options?: Option[];
  /** For "list": the columns of each row. */
  item?: FieldDef[];
  /** For "list": max rows. */
  max?: number;
  placeholder?: string;
  help?: L;
  /** Form tab: card (default), frame, art, set, collector. */
  tab?: "card" | "frame" | "art" | "set" | "collector";
  /** Hide unless the predicate passes. */
  when?: (f: Record<string, FieldValue>) => boolean;
}

export interface CardTypeDef {
  id: string;
  label: L;
  description: L;
  /** Thumbnail asset for the wizard (a frame image from the pack). */
  thumb?: string;
  fields: FieldDef[];
  defaults: Record<string, FieldValue>;
}

export interface Geo {
  width: number;
  height: number;
  bleed: number;
}

export interface Imported {
  cardType: string;
  fields: Record<string, FieldValue>;
  /** Scan of the real card (for the "from a real card" mode). */
  scanUrl?: string | null;
  name: string;
}

export interface TcgProfile {
  id: TcgId;
  name: string;
  packId: string;
  size: { width: number; height: number };
  cardTypes: CardTypeDef[];
  /** Default placement of the proxy mark for this game (e.g. over the frame's copyright line). */
  proxyMark?: import("../types").ProxyMark;
  /** Symbol palette for cost/rules fields. */
  symbols: { code: string; label: string }[];
  build(state: TcgState, geo: Geo): Layer[];
  /** Map raw API JSON from `card_details` (and the search hit) to fields. */
  fromApi?(raw: unknown): Imported | null;
  /** Parse pasted card text (Oracle-style). */
  parsePaste?(text: string): Partial<Imported> | null;
  /** Regions to repaint when the base is a real scan. */
  realMasks?(cardType: string): RealMask[];
}

export const str = (v: FieldValue | undefined, d = ""): string => (v === null || v === undefined ? d : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : d);
export const bool = (v: FieldValue | undefined): boolean => v === true || v === "true";
export const rows = (v: FieldValue | undefined): Record<string, string>[] => (Array.isArray(v) ? v : []);
