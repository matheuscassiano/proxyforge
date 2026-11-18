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
