import { describe, expect, it, beforeAll } from "vitest";
import { autoFrame, costColors, hybridPair, parseMtgText, fromScryfall } from "./mtg";
import { fromTcgdex } from "./pokemon";
import { fromFabCube } from "./fab";
import { mtgSymbolCode, pokemonType, symbolAsset } from "./symbols";
import { applyReminder, parseRich } from "../render";
import { drawProxyMark, effectiveMark, PROXY_TEXT, type MarkCtx } from "../proxyMark";
import mtgManifest from "../../../packs/manifests/mtg.json";
import pokemonManifest from "../../../packs/manifests/pokemon.json";
import fabManifest from "../../../packs/manifests/fab.json";

beforeAll(() => {
  if (!globalThis.crypto?.randomUUID) {
    let n = 0;
    (globalThis as any).crypto = { randomUUID: () => `id-${n++}` };
  }
});

describe("mtg frame logic", () => {
  it("reads colours and hybrids from costs", () => {
    expect(costColors("{2}{R}{G}")).toEqual(["r", "g"]);
    expect(costColors("{W/U}{B}")).toEqual(["w", "u", "b"]);
    expect(hybridPair("{W/U}{W/U}")).toEqual(["w", "u"]);
    expect(hybridPair("{U/W}{2}")).toEqual(["w", "u"]);
    expect(hybridPair("{W}{U}")).toBeNull();
    expect(hybridPair("{W/P}")).toBeNull();
  });
  it("picks the automatic frame", () => {
    expect(autoFrame({ frameColor: "auto", cost: "{R}", typeLine: "Instant" }).main).toBe("r");
    expect(autoFrame({ frameColor: "auto", cost: "{W}{U}", typeLine: "Creature" }).main).toBe("m");
    expect(autoFrame({ frameColor: "auto", cost: "{G/W}", typeLine: "Creature" })).toEqual({ main: "w", second: "g" });
    expect(autoFrame({ frameColor: "auto", cost: "{3}", typeLine: "Artifact Creature — Golem" }).main).toBe("a");
    expect(autoFrame({ frameColor: "auto", cost: "{7}", typeLine: "Creature — Eldrazi" }).main).toBe("c");
    expect(autoFrame({ frameColor: "auto", cost: "{3}", typeLine: "Artifact — Vehicle" }).main).toBe("v");
    expect(autoFrame({ frameColor: "auto", cost: "", typeLine: "Land" }).main).toBe("l");
    expect(autoFrame({ frameColor: "b", hybrid: "r", cost: "{G}" })).toEqual({ main: "b", second: "r" });
  });
  it("parses pasted Oracle text", () => {
    const p = parseMtgText("Shivan Dragon {4}{R}{R}\nCreature — Dragon\nFlying\n{R}: Shivan Dragon gets +1/+0 until end of turn.\n5/5")!;
    expect(p.fields).toMatchObject({ name: "Shivan Dragon", cost: "{4}{R}{R}", typeLine: "Creature — Dragon", power: "5", toughness: "5" });
    expect(String(p.fields!.rules)).toContain("Flying");
    const pw = parseMtgText("Jace {2}{U}{U}\nLegendary Planeswalker — Jace\n+2: Look.\n−1: Bounce.\nLoyalty: 3")!;
    expect(pw.cardType).toBe("planeswalker");
    expect(pw.fields!.loyalty).toBe("3");
  });
  it("maps Scryfall JSON", () => {
    const imp = fromScryfall({ name: "Lightning Bolt", mana_cost: "{R}", type_line: "Instant", oracle_text: "Deal 3.", set: "2x2", rarity: "uncommon", collector_number: "117", lang: "en", image_uris: { art_crop: "https://cards.scryfall.io/a.jpg", png: "https://cards.scryfall.io/p.png" } })!;
    expect(imp.cardType).toBe("regular");
    expect(imp.fields).toMatchObject({ cost: "{R}", rarity: "u", setCode: "2X2", art: "url:https://cards.scryfall.io/a.jpg" });
    expect(imp.scanUrl).toBe("https://cards.scryfall.io/p.png");
    const pw = fromScryfall({ name: "Jace", type_line: "Legendary Planeswalker — Jace", oracle_text: "+2: Look.\n0: Draw.", loyalty: "3" })!;
    expect(pw.cardType).toBe("planeswalker");
    expect(pw.fields.abilities).toEqual([{ cost: "+2", text: "Look." }, { cost: "0", text: "Draw." }]);
  });
});

describe("pokemon and fab import", () => {
  it("maps TCGdex JSON", () => {
    const imp = fromTcgdex({ name: "Charizard V", category: "Pokemon", hp: 220, types: ["Fire"], stage: "Basic", suffix: "V", attacks: [{ cost: ["Fire", "Colorless"], name: "Claw", damage: 60 }], weaknesses: [{ type: "Water", value: "×2" }], retreat: 2, localId: "19", set: { id: "swsh3", cardCount: { official: 189 } } })!;
    expect(imp.cardType).toBe("v");
    expect(imp.fields).toMatchObject({ hp: "220", type: "fire", weakness: "water", retreat: 2, number: "19/189" });
    expect(imp.fields.attacks).toEqual([{ cost: "{fire}{colorless}", name: "Claw", damage: "60", text: "" }]);
    expect(fromTcgdex({ name: "Professor's Research", category: "Trainer", trainerType: "Supporter", effect: "Draw 7." })!.fields).toMatchObject({ trainerKind: "supporter", text: "Draw 7." });
  });
  it("maps the-fab-cube JSON", () => {
    const imp = fromFabCube({ name: "Snatch", pitch: "1", cost: "0", power: "4", defense: "2", types: ["Generic", "Action", "Attack"], type_text: "Generic Action – Attack", printing: { id: "WTR167", rarity: "C", artists: ["A"] } })!;
    expect(imp.cardType).toBe("action");
    expect(imp.fields).toMatchObject({ pitch: "1", power: "4", set: "WTR167", artist: "A" });
    expect(fromFabCube({ name: "Katsu", types: ["Ninja", "Hero", "Young"], health: 20, intelligence: 4 })!.cardType).toBe("hero");
  });
});

describe("symbols and rich text", () => {
  it("normalises symbol codes", () => {
    expect(mtgSymbolCode("u/w")).toBe("WU");
    expect(mtgSymbolCode("W/P")).toBe("WP");
    expect(mtgSymbolCode("tap")).toBe("T");
    expect(mtgSymbolCode("zz")).toBeNull();
    expect(pokemonType("R")).toBe("fire");
    expect(pokemonType("Darkness")).toBe("dark");
    expect(symbolAsset("mtg", "2/W")).toBe("pack:mtg/symbols/2W.svg");
    expect(symbolAsset("fab", "R")).toBe("pack:fab/img/manaSymbols/fab/fabr.svg");
  });
  it("every MTG symbol asset is in the pack manifest", () => {
    const paths = new Set(mtgManifest.files.map((f) => f.path));
    for (const c of ["W", "U", "B", "R", "G", "C", "T", "Q", "X", "1", "15", "WU", "2G", "BP"]) {
      const id = symbolAsset("mtg", c)!;
      expect(paths.has(id.slice("pack:mtg/".length))).toBe(true);
    }
  });
  it("handles reminder text and rules", () => {
    expect(applyReminder("Flying (Can't be blocked.)", "italic")).toBe("Flying *(Can't be blocked.)*");
    expect(applyReminder("Flying (Can't be blocked.)\nTrample", "hide")).toBe("Flying\nTrample");
    const runs = parseRich("Rules\n---\n*Flavor*");
    expect(runs.some((r) => r.rule)).toBe(true);
    expect(parseRich("{colorless}").find((r) => r.symbol)?.text).toBe("colorless");
  });
});

describe("pack manifests", () => {
  it("have safe relative paths and list their fonts", () => {
    for (const m of [mtgManifest, pokemonManifest, fabManifest] as { files: { path: string }[]; fonts: { file: string }[] }[]) {
      for (const f of m.files) expect(f.path.startsWith("/") || f.path.split("/").includes("..")).toBe(false);
      const paths = new Set(m.files.map((f) => f.path));
      for (const f of m.fonts) expect(paths.has(f.file)).toBe(true);
    }
  });
});

function fakeCtx() {
  const calls: { op: string; text?: string; alpha: number }[] = [];
  const ctx: MarkCtx & { calls: typeof calls } = {
    calls,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineJoin: "miter",
    textAlign: "left",
    textBaseline: "alphabetic",
    shadowColor: "",
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    measureText: (t: string) => ({ width: t.length * 5 }),
    fillText(t: string) {
      calls.push({ op: "fill", text: t, alpha: this.globalAlpha });
    },
    strokeText(t: string) {
      calls.push({ op: "stroke", text: t, alpha: this.globalAlpha });
    },
  };
  return ctx;
}

describe("proxy mark", () => {
  it("is always drawn and cannot be faded out or shrunk away", () => {
    const ctx = fakeCtx();
    drawProxyMark(ctx, { width: 63, height: 88, bleed: 3, proxyMark: { position: "bottom", opacity: 0, size: 0.1, inset: -5 } }, 10);
    const fill = ctx.calls.find((c) => c.op === "fill")!;
    expect(fill.text).toBe(PROXY_TEXT);
    expect(fill.alpha).toBeGreaterThanOrEqual(0.5);
    const m = effectiveMark({ proxyMark: { position: "nowhere" as "top", opacity: Number.NaN, size: 0, inset: 99 } });
    expect(m.position).toBe("bottom");
    expect(m.opacity).toBeGreaterThanOrEqual(0.5);
    expect(m.size).toBeGreaterThanOrEqual(1.6);
    expect(m.inset).toBeLessThanOrEqual(6);
    expect(m.inset).toBeGreaterThanOrEqual(0.4);
  });
  it("is drawn when the design has no mark settings", () => {
    const ctx = fakeCtx();
    drawProxyMark(ctx, { width: 63, height: 88, bleed: 0 }, 4);
    expect(ctx.calls.filter((c) => c.text === PROXY_TEXT).length).toBe(2);
  });
});
