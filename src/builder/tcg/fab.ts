// Flesh and Blood profile. Geometry follows Card Conjurer's FaB version (1500×2100 frames);
// assets come from the "fab" pack.
import { packAsset } from "../assets";
import type { FieldValue, Layer, RealMask, TcgState } from "../types";
import { kit, layers } from "./kit";
import { str, type CardTypeDef, type FieldDef, type Imported, type Option, type TcgProfile } from "./types";

const P = (path: string) => packAsset("fab", path);
const AMANDA = { font: "Amanda Std", fallback: "Cinzel", weight: 400 as const };
const PALATINO = { font: "Palatino FaB", fallback: "EB Garamond", weight: 400 as const };
const GOTHAM = { font: "Gotham Medium", fallback: "Montserrat" };

const f = (key: string, label: [string, string], kind: FieldDef["kind"], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: { en: label[0], pt: label[1] }, kind, ...extra });

export const CLASSES = ["generic", "brute", "guardian", "illusionist", "mechanologist", "ninja", "ranger", "runeblade", "warrior", "wizard"];
export const HEROES = ["aria", "demonastery", "metrix", "misteria", "savageLands", "solana", "solana2", "thePits", "volcor"];
const TALENTS = ["none", "light", "shadow", "elemental", "earth", "ice", "lightning"];

const PITCH: Option[] = [
  { value: "0", label: { en: "No pitch", pt: "Sem pitch" } },
  { value: "1", label: { en: "1 · red", pt: "1 · vermelho" } },
  { value: "2", label: { en: "2 · yellow", pt: "2 · amarelo" } },
  { value: "3", label: { en: "3 · blue", pt: "3 · azul" } },
];
const RARITY: Option[] = ["T", "C", "R", "S", "M", "L", "F", "P"].map((r) => ({ value: r, label: { en: r, pt: r } }));

const CARD_FIELDS: FieldDef[] = [
  f("name", ["Name", "Nome"], "text"),
  f("pitch", ["Pitch", "Pitch"], "select", { options: PITCH }),
  f("cost", ["Cost", "Custo"], "text"),
  f("typeLine", ["Type line", "Linha de tipo"], "text", { placeholder: "Ninja Action – Attack" }),
  f("text", ["Card text", "Texto da carta"], "rich", { help: { en: "{R} resource, {P} power, {D} defense, {I} intellect, {L} life", pt: "{R} recurso, {P} poder, {D} defesa, {I} intelecto, {L} vida" } }),
  f("flavor", ["Flavour text", "Texto de ambientação"], "rich"),
  f("power", ["Power", "Poder"], "text"),
  f("defense", ["Defense", "Defesa"], "text"),
];

const TAIL: FieldDef[] = [
  f("art", ["Art", "Arte"], "image", { tab: "art" }),
  f("artist", ["Artist", "Artista"], "text", { tab: "art" }),
  f("frameClass", ["Class frame", "Moldura de classe"], "select", { tab: "frame", options: CLASSES.map((c) => ({ value: c, label: { en: c, pt: c } })) }),
  f("talent", ["Talent", "Talento"], "select", { tab: "frame", options: TALENTS.map((c) => ({ value: c, label: { en: c, pt: c } })) }),
  f("set", ["Set + number", "Coleção + número"], "text", { tab: "collector", placeholder: "WTR167" }),
  f("rarity", ["Rarity", "Raridade"], "select", { tab: "collector", options: RARITY }),
];

const DEFAULTS: Record<string, FieldValue> = {
  name: "Head Jab",
  pitch: "1",
  cost: "0",
  typeLine: "Ninja Action – Attack",
  text: "If Head Jab hits, you may play your next attack action card this turn as though it had **go again**.",
  flavor: "",
  power: "3",
  defense: "3",
  art: null,
  artist: "Artist Name",
  frameClass: "ninja",
  talent: "none",
  set: "WTR098",
  rarity: "C",
};

const CARD_TYPES: CardTypeDef[] = [
  {
    id: "action",
    label: { en: "Action / attack", pt: "Ação / ataque" },
    description: { en: "Pitch strip, cost, power and defense", pt: "Faixa de pitch, custo, poder e defesa" },
    thumb: P("img/frames/fab/classes/ninja.png"),
    fields: [...CARD_FIELDS, ...TAIL],
    defaults: DEFAULTS,
  },
  {
    id: "instant",
    label: { en: "Instant / reaction", pt: "Instantânea / reação" },
    description: { en: "Defense reactions, attack reactions and instants", pt: "Reações de defesa, de ataque e instantâneas" },
    thumb: P("img/frames/fab/classes/guardian.png"),
    fields: [...CARD_FIELDS, ...TAIL],
    defaults: { ...DEFAULTS, name: "Sink Below", pitch: "1", cost: "0", typeLine: "Generic Defense Reaction", text: "You may put a card from your hand on the bottom of your deck. If you do, draw a card.", power: "", defense: "4", frameClass: "generic" },
  },
  {
    id: "equipment",
    label: { en: "Equipment", pt: "Equipamento" },
    description: { en: "Head, chest, arms, legs", pt: "Cabeça, peito, braços, pernas" },
    thumb: P("img/frames/fab/generic/equipment.png"),
    fields: [f("name", ["Name", "Nome"], "text"), f("typeLine", ["Type line", "Linha de tipo"], "text"), f("text", ["Card text", "Texto da carta"], "rich"), f("defense", ["Defense", "Defesa"], "text"), f("gold", ["Gold frame", "Moldura dourada"], "toggle", { tab: "frame" }), ...TAIL.filter((x) => x.key !== "frameClass")],
    defaults: { ...DEFAULTS, name: "Fyendal's Spring Tunic", pitch: "0", cost: "", typeLine: "Generic Equipment – Chest", text: "**Blade Break**", power: "", defense: "1", gold: false, rarity: "L" },
  },
  {
    id: "weapon",
    label: { en: "Weapon", pt: "Arma" },
    description: { en: "One- and two-handed weapons", pt: "Armas de uma ou duas mãos" },
    thumb: P("img/frames/fab/generic/weapon.png"),
    fields: [f("name", ["Name", "Nome"], "text"), f("typeLine", ["Type line", "Linha de tipo"], "text"), f("text", ["Card text", "Texto da carta"], "rich"), f("power", ["Power", "Poder"], "text"), ...TAIL.filter((x) => x.key !== "frameClass")],
    defaults: { ...DEFAULTS, name: "Harmonized Kodachi", pitch: "0", cost: "", typeLine: "Ninja Weapon – Dagger (1H)", text: "**Once per Turn Action** – {R}: **Attack**", power: "1", defense: "", rarity: "R" },
  },
  {
    id: "hero",
    label: { en: "Hero", pt: "Herói" },
    description: { en: "Life and intellect, hero frame", pt: "Vida e intelecto, moldura de herói" },
    thumb: P("img/frames/fab/heroes/aria.png"),
    fields: [
      f("name", ["Name", "Nome"], "text"),
      f("typeLine", ["Type line", "Linha de tipo"], "text"),
      f("text", ["Card text", "Texto da carta"], "rich"),
      f("intellect", ["Intellect", "Intelecto"], "text"),
      f("life", ["Life", "Vida"], "text"),
      f("heroFrame", ["Hero frame", "Moldura de herói"], "select", { tab: "frame", options: HEROES.map((h) => ({ value: h, label: { en: h, pt: h } })) }),
      ...TAIL.filter((x) => x.key !== "frameClass"),
    ],
    defaults: { ...DEFAULTS, name: "Katsu, the Wanderer", pitch: "0", cost: "", typeLine: "Ninja Hero – Young", text: "Once per Turn Effect – When you play an attack action card, you may pay {R} and discard a card...", intellect: "4", life: "20", heroFrame: "misteria", rarity: "T" },
  },
];

// ---------------------------------------------------------------- build

function frameAsset(state: TcgState): string {
  const fl = state.fields;
  switch (state.cardType) {
    case "equipment":
      return P(`img/frames/fab/generic/${fl.gold ? "equipment2" : "equipment"}.png`);
    case "weapon":
      return P("img/frames/fab/generic/weapon.png");
    case "hero":
      return P(`img/frames/fab/heroes/${str(fl.heroFrame, "aria")}.png`);
    default: {
      const t = str(fl.talent, "none");
      const c = str(fl.frameClass, "generic");
      if (t === "light" || t === "shadow") return P(`img/frames/fab/talents/${t}/${t}.png`);
      if (t !== "none") return P(`img/frames/fab/talents/elemental/${t}.png`);
      return P(c === "generic" ? "img/frames/fab/generic/action.png" : `img/frames/fab/classes/${c}.png`);
    }
  }
}

function build(state: TcgState, geo: { width: number; height: number; bleed: number }): Layer[] {
  const fl = state.fields;
  const k = kit(geo);
  const frame = frameAsset(state);
  const pitch = str(fl.pitch, "0");
  const deck = state.cardType === "action" || state.cardType === "instant";
  const hero = state.cardType === "hero";
  const text = [str(fl.text).trim(), str(fl.flavor).trim() ? `---\n*${str(fl.flavor).trim()}*` : ""].filter(Boolean).join("\n");
  const left = hero ? str(fl.intellect) : str(fl.power);
  const right = hero ? str(fl.life) : str(fl.defense);
  const bottom = [str(fl.rarity), str(fl.set), str(fl.artist)].filter(Boolean).join("  ·  ");
  return layers(
    k.frameBleed("bleed", frame),
    k.img("art", "Arte", hero ? { x: 0, y: 0, w: 1, h: 1 } : { x: 0.0867, y: 0.1258, w: 0.8267, h: 0.4796 }, str(fl.art) || null, { bind: "art" }),
    k.frame("frame", "Moldura", frame),
    deck && pitch !== "0" && k.frame("pitch", "Faixa de pitch", P(`img/frames/fab/pitch/${pitch}.svg`)),
    deck && str(fl.cost) !== "" && k.frame("costBadge", "Selo de custo", P("img/frames/fab/addons/cost.svg")),
    !!left && !hero && k.frame("powerBadge", "Selo de poder", P("img/frames/fab/addons/spear.svg")),
    !!right && !hero && k.frame("defenseBadge", "Selo de defesa", P("img/frames/fab/addons/shield.svg")),
    k.txt("name", "Nome", { x: 0.19, y: 0.0705, w: 0.62, h: 0.0405 }, str(fl.name), 0.0405, { ...AMANDA, align: "center", vAlign: "middle", autoFit: true, bind: "name" }),
    deck && str(fl.cost) !== "" && k.txt("cost", "Custo", { x: 0.854, y: 0.0753, w: 0.0534, h: 0.031 }, str(fl.cost), 0.031, { ...PALATINO, color: "#ffffff", stroke: { color: "#000000", width: 0.12 }, align: "center", vAlign: "middle", bind: "cost" }),
    k.txt("text", "Texto", { x: 0.12, y: 0.6153, w: 0.76, h: 0.275 }, text, 0.0281, { ...PALATINO, vAlign: "middle", align: "center", autoFit: true, lineHeight: 1.2, symbols: "fab", symbolScale: 0.95, bind: "text" }),
    k.txt("type", "Linha de tipo", { x: 0.24, y: 0.8977, w: 0.52, h: 0.0281 }, str(fl.typeLine), 0.0281, { ...AMANDA, align: "center", vAlign: "middle", autoFit: true, bind: "typeLine" }),
    !!left && k.txt("left", hero ? "Intelecto" : "Poder", { x: 0.162, y: 0.9124, w: 0.0534, h: 0.0358 }, left, 0.0358, { ...PALATINO, weight: 400, align: "center", vAlign: "middle", color: "#111111" }),
    !!right && k.txt("right", hero ? "Vida" : "Defesa", { x: 0.7847, y: 0.9124, w: 0.0534, h: 0.0358 }, right, 0.0358, { ...PALATINO, weight: 400, align: "center", vAlign: "middle", color: "#111111" }),
    !!bottom && k.txt("info", "Rodapé", { x: 0.25, y: 1987 / 2100, w: 0.5, h: 0.0143 }, bottom, 0.0143, { ...GOTHAM, align: "center", vAlign: "middle", color: "#ffffff" }),
  );
}

// ---------------------------------------------------------------- import

/** the-fab-cube card (with the matched `printing`) → fields. */
export function fromFabCube(raw: unknown): Imported | null {
  const c = raw as Record<string, any>;
  if (!c || typeof c !== "object" || !c.name) return null;
  const types: string[] = Array.isArray(c.types) ? c.types : [];
  const classes = CLASSES.filter((x) => types.some((t) => t.toLowerCase() === x));
  const cardType = types.includes("Hero") ? "hero" : types.includes("Equipment") ? "equipment" : types.includes("Weapon") ? "weapon" : types.some((t) => /Reaction|Instant/.test(t)) ? "instant" : "action";
  const p = c.printing ?? {};
  const fields: Record<string, FieldValue> = {
    ...CARD_TYPES.find((t) => t.id === cardType)!.defaults,
    name: c.name,
    pitch: String(c.pitch ?? "") || "0",
    cost: String(c.cost ?? ""),
    typeLine: String(c.type_text ?? types.join(" ")),
    text: String(c.functional_text_plain ?? c.functional_text ?? "").replace(/\r/g, ""),
    flavor: String(p.flavor_text_plain ?? p.flavor_text ?? ""),
    power: String(c.power ?? ""),
    defense: String(c.defense ?? ""),
    intellect: String(c.intelligence ?? ""),
    life: String(c.health ?? ""),
    artist: Array.isArray(p.artists) ? p.artists.join(", ") : String(p.artist ?? ""),
    set: String(p.id ?? ""),
    rarity: String(p.rarity ?? "C"),
    frameClass: classes[0] ?? "generic",
    art: null,
  };
  return { cardType, fields, scanUrl: p.image_url ?? null, name: c.name };
}

const REAL_MASKS: RealMask[] = [
  { id: "name", label: "Nome", x: 0.19, y: 0.068, w: 0.62, h: 0.045, fill: "auto" },
  { id: "text", label: "Texto", x: 0.11, y: 0.61, w: 0.78, h: 0.28, fill: "auto" },
];

export const fab: TcgProfile = {
  id: "fab",
  name: "Flesh and Blood",
  packId: "fab",
  size: { width: 63, height: 88 },
  cardTypes: CARD_TYPES,
  symbols: [
    { code: "{R}", label: "Recurso" },
    { code: "{P}", label: "Poder" },
    { code: "{D}", label: "Defesa" },
    { code: "{I}", label: "Intelecto" },
    { code: "{L}", label: "Vida" },
  ],
  build,
  fromApi: fromFabCube,
  realMasks: () => REAL_MASKS.map((m) => ({ ...m })),
};
