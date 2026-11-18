import { describe, expect, it } from "vitest";
import { addPrintCopy, mergeNeighbours, moveEntry, moveInstance, sortCards, swapPrint } from "./deck";
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

describe("printings", () => {
  const base = (over: Partial<CardEntry> = {}): CardEntry => ({ id: "a", name: "Bolt", qty: 4, front: "f1", back: null, isToken: false, source: { game: "mtg", cardId: "p1", setCode: "A", number: "1" }, ...over });
  const print = (front: string, cardId: string): CardEntry => ({ id: "tmp", name: "Bolt", qty: 1, front, back: null, isToken: false, source: { game: "mtg", cardId, setCode: "B", number: "2" } });

  it("swaps every copy in place", () => {
    const out = swapPrint([base()], "a", print("f2", "p2"), 4);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "a", qty: 4, front: "f2" });
  });

  it("splits when only some copies switch", () => {
    const out = swapPrint([base(), base({ id: "z", front: "zz", name: "Other" })], "a", print("f2", "p2"), 2);
    expect(out.map((c) => [c.front, c.qty])).toEqual([["f1", 2], ["f2", 2], ["zz", 4]]);
    expect(out[1].id).not.toBe("a");
  });

  it("adds one copy in another printing next to the card", () => {
    let out = addPrintCopy([base({ qty: 1 })], "a", print("f2", "p2"));
    expect(out.map((c) => [c.front, c.qty])).toEqual([["f1", 1], ["f2", 1]]);
    out = addPrintCopy(out, "a", print("f2", "p2"));
    expect(out.map((c) => [c.front, c.qty])).toEqual([["f1", 1], ["f2", 2]]);
  });
});

describe("sortCards", () => {
  const c = (name: string, mv: number, colors: string, typeLine: string, isToken = false): CardEntry => ({
    id: name, name, qty: 1, front: name, isToken, meta: { manaValue: mv, colors, typeLine, rarity: "common" },
  });
  const deck = [c("Bolt", 1, "R", "Instant"), c("Goblin", 0, "R", "Token Creature", true), c("Bear", 2, "G", "Creature"), c("Lotus", 0, "", "Artifact"), c("Swords", 1, "W", "Instant")];
  it("orders by mana value with tokens last", () => {
    expect(sortCards(deck, "manaValue").map((x) => x.name)).toEqual(["Lotus", "Bolt", "Swords", "Bear", "Goblin"]);
  });
  it("orders by colour WUBRG then colourless", () => {
    expect(sortCards(deck, "color").map((x) => x.name)).toEqual(["Swords", "Bolt", "Bear", "Lotus", "Goblin"]);
  });
  it("orders by type and by name", () => {
    expect(sortCards(deck, "type").map((x) => x.name)).toEqual(["Bear", "Bolt", "Swords", "Lotus", "Goblin"]);
    expect(sortCards(deck, "name").map((x) => x.name)).toEqual(["Bear", "Bolt", "Lotus", "Swords", "Goblin"]);
  });
});
