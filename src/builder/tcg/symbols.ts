// `{X}` codes inside rich text → symbol images from the game's asset pack.
import { packAsset } from "../assets";

const MTG = new Set([
  "W", "U", "B", "R", "G", "C", "S", "X", "Y", "Z", "T", "Q", "E", "P", "A", "CHAOS",
  "WP", "UP", "BP", "RP", "GP", "WU", "WB", "UB", "UR", "BR", "BG", "RG", "RW", "GW", "GU", "2W", "2U", "2B", "2R", "2G",
  ...Array.from({ length: 21 }, (_, i) => String(i)),
]);
// Scryfall spells hybrids in WUBRG order ({U/W} and {W/U} are the same symbol).
const HYBRID_ORDER: Record<string, string> = { UW: "WU", BW: "WB", BU: "UB", RU: "UR", RB: "BR", GB: "BG", GR: "RG", WR: "RW", WG: "GW", UG: "GU" };

export function mtgSymbolCode(code: string): string | null {
  let c = code.toUpperCase().replace(/\//g, "").trim();
  if (c === "TAP") c = "T";
  if (c === "UNTAP") c = "Q";
  if (HYBRID_ORDER[c]) c = HYBRID_ORDER[c];
  return MTG.has(c) ? c : null;
}

export const POKEMON_TYPES: Record<string, string> = {
  G: "grass", R: "fire", W: "water", L: "lightning", P: "psychic", F: "fighting", D: "dark", M: "metal", C: "colorless", N: "dragon", Y: "fairy",
};
const POKEMON_NAMES = new Set(Object.values(POKEMON_TYPES));

export function pokemonType(code: string): string | null {
  const c = code.trim();
  if (POKEMON_TYPES[c.toUpperCase()] && c.length === 1) return POKEMON_TYPES[c.toUpperCase()];
  const low = c.toLowerCase();
  if (low === "darkness") return "dark";
  if (low === "electric") return "lightning";
  if (low === "steel") return "metal";
  return POKEMON_NAMES.has(low) ? low : null;
}

/** Flesh and Blood icons as drawn by the pack (Card Conjurer's fab set). */
const FAB: Record<string, string> = { R: "fabr", P: "fabw", A: "fabw", D: "fabb", I: "fabu", L: "fabg", H: "fabg" };

/** Symbols drawn in the text colour instead of their own (the artist brush). */
export const tintedSymbol = (set: string | undefined, code: string) => set === "mtg" && code.toLowerCase() === "brush";

/** SWSH energy coins: disc colour + glyph colour; the glyph comes from the pack's symbol font. */
export const POKEMON_COIN: Record<string, { disc: string; glyph: string; letter: string }> = {
  grass: { disc: "#3f9a3a", glyph: "#ffffff", letter: "G" },
  fire: { disc: "#e4462c", glyph: "#ffffff", letter: "R" },
  water: { disc: "#2f8fd8", glyph: "#ffffff", letter: "W" },
  lightning: { disc: "#f6cb2b", glyph: "#1b1b1b", letter: "L" },
  psychic: { disc: "#8b4ea6", glyph: "#ffffff", letter: "P" },
  fighting: { disc: "#c06a2e", glyph: "#ffffff", letter: "F" },
  dark: { disc: "#255563", glyph: "#ffffff", letter: "D" },
  metal: { disc: "#9aa5ad", glyph: "#1b1b1b", letter: "M" },
  colorless: { disc: "#f2f1ec", glyph: "#1b1b1b", letter: "C" },
  dragon: { disc: "#b39029", glyph: "#1b1b1b", letter: "N" },
  fairy: { disc: "#e2509d", glyph: "#ffffff", letter: "Y" },
};

/** Asset id for a symbol code, or null to fall back to the drawn circle. */
export function symbolAsset(set: string | undefined, code: string): string | null {
  if (!set) return null;
  if (set === "mtg") {
    if (code.toLowerCase() === "brush") return packAsset("mtg", "img/manaSymbols/artistbrush.svg");
    const c = mtgSymbolCode(code);
    return c ? packAsset("mtg", `symbols/${c}.svg`) : null;
  }
  if (set === "fab") {
    const f = FAB[code.toUpperCase()];
    return f ? packAsset("fab", `img/manaSymbols/fab/${f}.svg`) : null;
  }
  return null;
}
