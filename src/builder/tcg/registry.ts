import type { CardDesign, FieldValue, RealBase } from "../types";
import { DEFAULT_MARK } from "../proxyMark";
import { fab } from "./fab";
import { mtg } from "./mtg";
import { pokemon } from "./pokemon";
import type { L, TcgId, TcgProfile } from "./types";
import { rebuild } from "./sync";

export const PROFILES: Record<TcgId, TcgProfile> = { mtg, pokemon, fab };

export function profileFor(game: string | undefined | null): TcgProfile | null {
  return game && game in PROFILES ? PROFILES[game as TcgId] : null;
}

export const tr = (l: L, lang: string) => (lang.startsWith("pt") ? l.pt : l.en);

/** New design driven by a TCG profile. Bleed is 3 mm like the generic templates. */
export function createTcgDesign(
  game: TcgId,
  cardType: string,
  fields: Record<string, FieldValue> = {},
  opts: { name?: string; bleed?: number; base?: RealBase | null } = {},
): CardDesign {
  const p = PROFILES[game];
  const type = p.cardTypes.find((t) => t.id === cardType) ?? p.cardTypes[0];
  const merged = { ...type.defaults, ...fields };
  const d: CardDesign = {
    id: crypto.randomUUID(),
    name: opts.name || String(merged.name || type.label.en),
    width: p.size.width,
    height: p.size.height,
    bleed: opts.bleed ?? 3,
    safe: 3,
    layers: [],
    backId: null,
    updatedAt: new Date().toISOString(),
    tcg: { game, cardType: type.id, fields: merged, overrides: {}, base: opts.base ?? null },
    proxyMark: { ...DEFAULT_MARK, ...(p.proxyMark ?? {}) },
  };
  return rebuild(d);
}

/** Switch card type keeping the fields both types share. */
export function changeCardType(d: CardDesign, cardType: string): CardDesign {
  const p = profileFor(d.tcg?.game);
  if (!p || !d.tcg) return d;
  const type = p.cardTypes.find((t) => t.id === cardType);
  if (!type) return d;
  const keys = new Set(type.fields.map((f) => f.key));
  const kept = Object.fromEntries(Object.entries(d.tcg.fields).filter(([k]) => keys.has(k)));
  return rebuild({ ...d, tcg: { ...d.tcg, cardType, fields: { ...type.defaults, ...kept }, overrides: {} } });
}
