// Pure deck reordering helpers used by drag & drop on the sheet and in the deck list.
import type { CardEntry } from "./types";

/** Two entries print the same card (they can share one row). */
export function sameCard(a: CardEntry, b: CardEntry): boolean {
  return (
    a.front === b.front &&
    (a.back ?? null) === (b.back ?? null) &&
    a.name === b.name &&
    (a.builtinBleedMm ?? null) === (b.builtinBleedMm ?? null) &&
    a.isToken === b.isToken &&
    (a.designId ?? null) === (b.designId ?? null) &&
    (a.originalFront ?? null) === (b.originalFront ?? null) &&
    (a.originalBack ?? null) === (b.originalBack ?? null)
  );
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Move one printed copy from position `from` to position `to` in the flattened deck
 * (every copy of every card, in print order). The copy ends up exactly at `to`.
 * Entries are split when a copy leaves the middle of a run, and identical neighbours
 * are merged back, so `qty` totals never change.
 */
export function moveInstance(cards: CardEntry[], from: number, to: number): CardEntry[] {
  const flat = cards.flatMap((c, i) => Array.from({ length: c.qty }, () => i));
  if (from === to || from < 0 || to < 0 || from >= flat.length || to >= flat.length) return cards;
  const [moved] = flat.splice(from, 1);
  flat.splice(to, 0, moved);

  // consecutive copies of the same entry form one run
  const runs: { ci: number; qty: number }[] = [];
  for (const ci of flat) {
    const last = runs[runs.length - 1];
    if (last && last.ci === ci) last.qty += 1;
    else runs.push({ ci, qty: 1 });
  }
  // the first run of an entry keeps its id; extra runs (a split) get a fresh one
  const used = new Set<number>();
  const out = runs.map(({ ci, qty }) => {
    const id = used.has(ci) ? newId() : cards[ci].id;
    used.add(ci);
    return { ...cards[ci], id, qty };
  });
  return mergeNeighbours(out);
}

/** Merge consecutive entries that print the same card; the first keeps its id. */
export function mergeNeighbours(cards: CardEntry[]): CardEntry[] {
  const out: CardEntry[] = [];
  for (const c of cards) {
    const last = out[out.length - 1];
    if (last && sameCard(last, c)) last.qty += c.qty;
    else out.push({ ...c });
  }
  return out;
}

/** Move a whole deck row (all its copies) from index `from` to index `to`. */
export function moveEntry(cards: CardEntry[], from: number, to: number): CardEntry[] {
  if (from === to || from < 0 || to < 0 || from >= cards.length || to >= cards.length) return cards;
  const next = [...cards];
  const [m] = next.splice(from, 1);
  next.splice(to, 0, m);
  return next;
}

/** Fields of `print` that define which printing an entry shows. */
function withPrint(base: CardEntry, print: CardEntry): CardEntry {
  return {
    ...base,
    name: print.name || base.name,
    front: print.front,
    back: print.back ?? null,
    source: print.source ?? null,
    builtinBleedMm: print.builtinBleedMm ?? null,
    isToken: print.isToken,
    originalFront: null,
    originalBack: null,
    designId: null,
  };
}

/**
 * Switch `count` copies of entry `id` to another printing. All copies: the entry changes in place.
 * Some copies: the entry keeps the rest and a new entry with the new printing follows it.
 */
export function swapPrint(cards: CardEntry[], id: string, print: CardEntry, count: number): CardEntry[] {
  const i = cards.findIndex((c) => c.id === id);
  if (i < 0) return cards;
  const cur = cards[i];
  const n = Math.max(1, Math.min(Math.round(count), cur.qty));
  const next = [...cards];
  if (n >= cur.qty) {
    next[i] = withPrint(cur, print);
    // keep a user-chosen back (custom back) only if the new printing has none
    if (!print.back && cur.back && !cur.source) next[i].back = cur.back;
    return next;
  }
  next[i] = { ...cur, qty: cur.qty - n };
  next.splice(i + 1, 0, { ...withPrint(cur, print), id: newId(), qty: n });
  return next;
}

/** One more copy of the card in another printing, right after entry `id` (or merged into an identical neighbour). */
export function addPrintCopy(cards: CardEntry[], id: string, print: CardEntry): CardEntry[] {
  const i = cards.findIndex((c) => c.id === id);
  if (i < 0) return cards;
  const fresh = { ...withPrint(cards[i], print), id: newId(), qty: 1 };
  const next = [...cards];
  if (sameCard(cards[i], fresh)) {
    next[i] = { ...cards[i], qty: cards[i].qty + 1 };
    return next;
  }
  const j = i + 1;
  if (next[j] && sameCard(next[j], fresh)) next[j] = { ...next[j], qty: next[j].qty + 1 };
  else next.splice(j, 0, fresh);
  return next;
}

export type DeckSort = "name" | "manaValue" | "color" | "set" | "type";

const COLOR_ORDER = "WUBRG";
const TYPE_ORDER = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land"];

function colorRank(c: string): number {
  if (!c) return 7; // colourless after multicolour
  if (c.length > 1) return 6;
  return COLOR_ORDER.indexOf(c);
}

function typeRank(t: string): number {
  const i = TYPE_ORDER.findIndex((x) => t.includes(x));
  return i < 0 ? TYPE_ORDER.length : i;
}

/** Stable sort of the deck rows; tokens always go last, ties keep name order. */
export function sortCards(cards: CardEntry[], by: DeckSort): CardEntry[] {
  const num = (n?: string) => parseInt(n ?? "", 10) || 0;
  const key = (c: CardEntry): (string | number)[] => {
    const m = c.meta;
    switch (by) {
      case "manaValue":
        return [m?.manaValue ?? 99];
      case "color":
        return [colorRank(m?.colors ?? ""), m?.colors ?? ""];
      case "set":
        return [c.source?.setCode ?? "~", num(c.source?.number)];
      case "type":
        return [typeRank(m?.typeLine ?? "")];
      default:
        return [];
    }
  };
  return cards
    .map((c, i) => ({ c, i, k: [c.isToken ? 1 : 0, ...key(c), c.name.toLowerCase()] }))
    .sort((a, b) => {
      for (let j = 0; j < a.k.length; j++) {
        if (a.k[j] < b.k[j]) return -1;
        if (a.k[j] > b.k[j]) return 1;
      }
      return a.i - b.i;
    })
    .map((x) => x.c);
}

/** Decklist text: "4 Lightning Bolt (2X2) 117", in deck order or alphabetical. */
export function decklistText(cards: CardEntry[], alphabetical: boolean): string {
  const rows = new Map<string, { qty: number; line: string; token: boolean }>();
  for (const c of cards) {
    const set = c.source?.setCode ? ` (${c.source.setCode})${c.source.number ? ` ${c.source.number}` : ""}` : "";
    const line = `${c.name}${set}`;
    const r = rows.get(line);
    if (r) r.qty += c.qty;
    else rows.set(line, { qty: c.qty, line, token: c.isToken });
  }
  let list = [...rows.values()];
  if (alphabetical) list = list.sort((a, b) => a.line.localeCompare(b.line));
  const main = list.filter((r) => !r.token).map((r) => `${r.qty} ${r.line}`);
  const tokens = list.filter((r) => r.token).map((r) => `${r.qty} ${r.line}`);
  return [...main, ...(tokens.length ? ["", "Tokens", ...tokens] : [])].join("\n") + "\n";
}
