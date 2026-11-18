// Keeps a TCG design's generated layers in step with its fields.
//
// rebuild(): fields → slot layers (+ per-slot overrides), free layers kept on top.
// capture(): after a canvas/property edit, the differences between each edited slot layer and
//            its freshly generated version become overrides (or field values for bound text/art),
//            so the next rebuild keeps them.
import type { CardDesign, FieldValue, Layer, TcgState } from "../types";
import { profileFor } from "./registry";

/** Keys that never become overrides (identity / content owned by the profile). */
const SKIP = new Set(["id", "slot", "kind", "bind", "name"]);

function generated(d: CardDesign, tcg: TcgState): Layer[] {
  const p = profileFor(tcg.game);
  if (!p) return [];
  return p.build(tcg, { width: d.width, height: d.height, bleed: d.bleed });
}

function applyOverride(l: Layer, o: Record<string, unknown> | undefined): Layer {
  return o ? ({ ...l, ...o, id: l.id, slot: l.slot, kind: l.kind } as Layer) : l;
}

export function rebuild(d: CardDesign): CardDesign {
  const tcg = d.tcg;
  if (!tcg) return d;
  const gen = generated(d, tcg).map((l) => applyOverride(l, tcg.overrides[l.slot!]));
  const free = d.layers.filter((l) => !l.slot);
  return { ...d, layers: [...gen, ...free] };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Fold edits of slot layers back into overrides / fields, then rebuild. */
export function capture(prev: CardDesign, next: CardDesign): CardDesign {
  const tcg = next.tcg;
  if (!tcg) return next;
  const fields: Record<string, FieldValue> = { ...tcg.fields };
  const overrides: Record<string, Record<string, unknown>> = structuredClone(tcg.overrides ?? {});
  const base = new Map(generated(next, { ...tcg, fields }).map((l) => [l.slot!, l]));
  const prevSlots = new Map(prev.layers.filter((l) => l.slot).map((l) => [l.slot!, l]));
  const nextSlots = new Map(next.layers.filter((l) => l.slot).map((l) => [l.slot!, l]));
  // deleted slot layers are hidden instead (they would come back on rebuild)
  for (const slot of prevSlots.keys()) {
    if (!nextSlots.has(slot)) overrides[slot] = { ...(overrides[slot] ?? {}), visible: false };
  }
  for (const [slot, l] of nextSlots) {
    const g = base.get(slot);
    if (!g) continue;
    const before = prevSlots.get(slot);
    if (before && same(before, l)) continue;
    // bound content goes back to its field
    if (l.bind) {
      if (l.kind === "text" && g.kind === "text" && l.text !== (before as typeof l | undefined)?.text) fields[l.bind] = l.text;
      if (l.kind === "image" && g.kind === "image" && l.imageId !== (before as typeof l | undefined)?.imageId) fields[l.bind] = l.imageId;
    }
    const o: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(l)) {
      if (SKIP.has(key)) continue;
      if (l.bind && (key === "text" || key === "imageId")) continue;
      if (!same(val, (g as unknown as Record<string, unknown>)[key])) o[key] = val;
    }
    if (Object.keys(o).length) overrides[slot] = o;
    else delete overrides[slot];
  }
  return rebuild({ ...next, tcg: { ...tcg, fields, overrides } });
}

/** Turn a generated layer into a free one (kept as-is, no longer driven by fields). */
export function detach(d: CardDesign, layerId: string): { design: CardDesign; newId: string | null } {
  const l = d.layers.find((x) => x.id === layerId);
  if (!d.tcg || !l?.slot) return { design: d, newId: null };
  const copy = { ...structuredClone(l), id: crypto.randomUUID(), slot: undefined, bind: undefined, locked: false } as Layer;
  const overrides = { ...d.tcg.overrides, [l.slot]: { ...(d.tcg.overrides[l.slot] ?? {}), visible: false } };
  const next = rebuild({ ...d, tcg: { ...d.tcg, overrides }, layers: [...d.layers, copy] });
  return { design: next, newId: copy.id };
}

/** Forget every canvas edit of one slot (or all slots). */
export function resetOverrides(d: CardDesign, slot?: string): CardDesign {
  if (!d.tcg) return d;
  const overrides = slot ? Object.fromEntries(Object.entries(d.tcg.overrides).filter(([k]) => k !== slot)) : {};
  return rebuild({ ...d, tcg: { ...d.tcg, overrides } });
}

export function setFields(d: CardDesign, patch: Record<string, FieldValue>): CardDesign {
  if (!d.tcg) return d;
  return rebuild({ ...d, tcg: { ...d.tcg, fields: { ...d.tcg.fields, ...patch } } });
}

/** Slots hidden when a real scan is the base (the scan already has frame and art). */
export const BASE_HIDDEN_SLOTS = ["frame", "frame2", "bleed", "bg", "art", "ptBox", "crown", "pitch", "costBadge", "powerBadge", "defenseBadge", "prevolve"];

export function withBaseVisibility(overrides: Record<string, Record<string, unknown>>, hide: boolean) {
  const o = { ...overrides };
  for (const slot of BASE_HIDDEN_SLOTS) {
    if (hide) o[slot] = { ...(o[slot] ?? {}), visible: false };
    else if (o[slot]) {
      const { visible: _v, ...rest } = o[slot];
      if (Object.keys(rest).length) o[slot] = rest;
      else delete o[slot];
    }
  }
  return o;
}
