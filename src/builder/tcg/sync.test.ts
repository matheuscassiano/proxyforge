import { describe, expect, it } from "vitest";
import { createTcgDesign, changeCardType, PROFILES } from "./registry";
import { capture, detach, rebuild, resetOverrides, setFields, withBaseVisibility } from "./sync";
import type { Layer, TextLayer } from "../types";

const slot = (layers: Layer[], s: string) => layers.find((l) => l.slot === s)!;

describe("TCG designs", () => {
  it("every card type of every profile builds stable, unique slots", () => {
    for (const p of Object.values(PROFILES)) {
      for (const t of p.cardTypes) {
        const d = createTcgDesign(p.id, t.id);
        const slots = d.layers.map((l) => l.slot);
        expect(new Set(slots).size, `${p.id}/${t.id}`).toBe(slots.length);
        expect(slots.every(Boolean)).toBe(true);
        expect(d.layers.every((l) => l.id === `slot:${l.slot}`)).toBe(true);
        expect(rebuild(d).layers.map((l) => l.id)).toEqual(d.layers.map((l) => l.id));
      }
    }
  });

  it("keeps canvas edits of generated layers as overrides across field changes", () => {
    const d = createTcgDesign("mtg", "regular");
    const moved = { ...d, layers: d.layers.map((l) => (l.slot === "name" ? { ...l, x: l.x + 2, size: 12 } : l)) };
    const c = capture(d, moved as typeof d);
    expect(c.tcg!.overrides.name).toMatchObject({ x: slot(d.layers, "name").x + 2, size: 12 });
    const renamed = setFields(c, { name: "Bolt" });
    const name = slot(renamed.layers, "name") as TextLayer;
    expect(name.text).toBe("Bolt");
    expect(name.x).toBeCloseTo(slot(d.layers, "name").x + 2);
    expect(resetOverrides(renamed, "name").tcg!.overrides.name).toBeUndefined();
  });

  it("writes text edited on a bound layer back to its field", () => {
    const d = createTcgDesign("pokemon", "basic");
    const edited = { ...d, layers: d.layers.map((l) => (l.slot === "name" ? { ...l, text: "Pikachu" } : l)) } as typeof d;
    const c = capture(d, edited);
    expect(c.tcg!.fields.name).toBe("Pikachu");
    expect(c.tcg!.overrides.name).toBeUndefined();
  });

  it("hides deleted generated layers and detaches into free layers", () => {
    const d = createTcgDesign("fab", "action");
    const deleted = capture(d, { ...d, layers: d.layers.filter((l) => l.slot !== "info") });
    expect(slot(deleted.layers, "info").visible).toBe(false);
    const { design, newId } = detach(d, "slot:name");
    expect(design.layers.find((l) => l.id === newId)?.slot).toBeUndefined();
    expect(slot(design.layers, "name").visible).toBe(false);
    // free layers survive rebuilds, on top
    expect(rebuild(design).layers.at(-1)?.id).toBe(newId);
  });

  it("keeps shared fields when switching card type", () => {
    const d = setFields(createTcgDesign("mtg", "regular"), { name: "Keep me" });
    const pw = changeCardType(d, "planeswalker");
    expect(pw.tcg!.cardType).toBe("planeswalker");
    expect(pw.tcg!.fields.name).toBe("Keep me");
    expect(pw.layers.some((l) => l.slot === "loyalty")).toBe(true);
  });

  it("real-card bases hide the generated frame", () => {
    const o = withBaseVisibility({}, true);
    expect(o.frame).toEqual({ visible: false });
    expect(withBaseVisibility(o, false)).toEqual({});
  });

  it("uses the profile's proxy mark placement", () => {
    expect(createTcgDesign("pokemon", "basic").proxyMark?.inset).toBeCloseTo(0.45);
  });
});
