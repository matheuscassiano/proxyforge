import { describe, expect, it } from "vitest";
import { mergeNeighbours, moveEntry, moveInstance } from "./deck";
import type { CardEntry } from "./types";

const card = (id: string, qty: number, front = `img-${id}`): CardEntry => ({ id, name: id.toUpperCase(), qty, front, isToken: false });
const flat = (cards: CardEntry[]) => cards.flatMap((c) => Array.from({ length: c.qty }, () => c.name)).join("");
const total = (cards: CardEntry[]) => cards.reduce((a, c) => a + c.qty, 0);

describe("moveInstance", () => {
  it("moves a single copy between entries", () => {
    const deck = [card("a", 1), card("b", 1), card("c", 1)];
    const r = moveInstance(deck, 0, 2);
    expect(flat(r)).toBe("BCA");
    expect(r.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("splits an entry when one copy leaves the run", () => {
    const deck = [card("a", 3), card("b", 2)];
    const r = moveInstance(deck, 0, 4); // first A goes to the end
    expect(flat(r)).toBe("AABBA");
    expect(total(r)).toBe(5);
    expect(r).toHaveLength(3);
    expect(r[0].id).toBe("a");
    expect(r[2].id).not.toBe("a");
    expect(r[2].front).toBe("img-a");
  });

  it("merges the copy back when it returns next to its run", () => {
    const deck = [card("a", 3), card("b", 2)];
    const split = moveInstance(deck, 0, 4);
    const back = moveInstance(split, 4, 0);
    expect(flat(back)).toBe("AAABB");
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ front: "img-a", qty: 3 });
  });

  it("moves a copy into the middle of another run", () => {
    const deck = [card("a", 1), card("b", 4)];
    const r = moveInstance(deck, 0, 2);
    expect(flat(r)).toBe("BBABB");
    expect(r.map((c) => c.qty)).toEqual([2, 1, 2]);
    expect(new Set(r.map((c) => c.id)).size).toBe(3);
  });

  it("ignores out-of-range and no-op moves", () => {
    const deck = [card("a", 2)];
    expect(moveInstance(deck, 0, 0)).toBe(deck);
    expect(moveInstance(deck, 0, 5)).toBe(deck);
    expect(moveInstance(deck, -1, 1)).toBe(deck);
  });

  it("does not mutate the input", () => {
    const deck = [card("a", 2), card("b", 1)];
    const copy = structuredClone(deck);
    moveInstance(deck, 0, 2);
    expect(deck).toEqual(copy);
  });
});

describe("moveEntry / mergeNeighbours", () => {
  it("reorders whole rows", () => {
    expect(moveEntry([card("a", 1), card("b", 2), card("c", 1)], 2, 0).map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("merges identical neighbours only", () => {
    const r = mergeNeighbours([card("a", 1, "x"), card("b", 2, "x"), card("c", 1, "y")].map((c) => ({ ...c, name: "same" })));
    expect(r.map((c) => [c.id, c.qty])).toEqual([
      ["a", 3],
      ["c", 1],
    ]);
  });
});
