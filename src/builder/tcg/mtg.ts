// Magic: The Gathering profile. Geometry follows Card Conjurer's M15 frame packs
// (fractions of a 2010×2814 card); assets come from the "mtg" pack.
import { packAsset, urlAsset } from "../assets";
import type { FieldValue, Layer, RealMask, TcgState } from "../types";
import { kit, layers, type Box } from "./kit";
import { bool, rows, str, type CardTypeDef, type FieldDef, type Imported, type Option, type TcgProfile } from "./types";

const P = (path: string) => packAsset("mtg", path);
const TITLE = { font: "Beleren Bold", fallback: "Cinzel", weight: 700 as const };
const RULES = { font: "MPlantin", fallback: "EB Garamond" };
const SMALL = { font: "Gotham Medium", fallback: "Montserrat" };

export type FrameLetter = "w" | "u" | "b" | "r" | "g" | "m" | "a" | "l" | "c" | "v";
const WUBRG = ["w", "u", "b", "r", "g"] as const;

/** Colours present in a mana cost, in WUBRG order. Hybrid symbols count both halves. */
export function costColors(cost: string): string[] {
  const found = new Set<string>();
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
    for (const ch of m[1].toLowerCase()) if ((WUBRG as readonly string[]).includes(ch)) found.add(ch);
  }
  return WUBRG.filter((c) => found.has(c));
}

/** True when every coloured symbol is a two-colour hybrid of the same pair ({W/U}{W/U}). */
export function hybridPair(cost: string): [string, string] | null {
  const syms = [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1].toLowerCase().replace(/\//g, ""));
  const coloured = syms.filter((s) => /[wubrg]/.test(s));
  if (!coloured.length) return null;
  const pair = coloured[0].replace(/[^wubrg]/g, "");
  if (pair.length !== 2 || coloured.some((s) => s.replace(/[^wubrg]/g, "") !== pair || s.includes("p"))) return null;
  const ordered = WUBRG.filter((c) => pair.includes(c));
  return [ordered[0], ordered[1]];
}

/** Frame colour from the fields (an explicit choice wins over the automatic one). */
export function autoFrame(f: Record<string, FieldValue>): { main: FrameLetter; second: string | null } {
  const forced = str(f.frameColor, "auto");
  const second = str(f.hybrid, "none");
  if (forced !== "auto") return { main: forced as FrameLetter, second: second !== "none" ? second : null };
  const type = str(f.typeLine).toLowerCase();
  const cost = str(f.cost);
  if (/\bland\b|terreno/.test(type)) return { main: "l", second: null };
  const colors = costColors(cost);
  if (colors.length === 0) {
    if (/vehicle|veículo/.test(type)) return { main: "v", second: null };
    return { main: /artifact|artefato/.test(type) ? "a" : "c", second: null };
  }
  if (colors.length === 1) return { main: colors[0] as FrameLetter, second: null };
  const pair = colors.length === 2 ? hybridPair(cost) : null;
  if (pair) return { main: pair[0] as FrameLetter, second: pair[1] };
  return { main: "m", second: null };
}

const isCreature = (f: Record<string, FieldValue>) => /creature|criatura|vehicle|veículo/i.test(str(f.typeLine)) || !!str(f.power) || !!str(f.toughness);

// ---------------------------------------------------------------- fields

const COLOR_OPTIONS: Option[] = [
  { value: "auto", label: { en: "Automatic (from cost and type)", pt: "Automática (pelo custo e tipo)" } },
  { value: "w", label: { en: "White", pt: "Branco" } },
  { value: "u", label: { en: "Blue", pt: "Azul" } },
  { value: "b", label: { en: "Black", pt: "Preto" } },
  { value: "r", label: { en: "Red", pt: "Vermelho" } },
  { value: "g", label: { en: "Green", pt: "Verde" } },
  { value: "m", label: { en: "Multicolour (gold)", pt: "Multicolorida (dourado)" } },
  { value: "a", label: { en: "Artifact", pt: "Artefato" } },
  { value: "l", label: { en: "Land", pt: "Terreno" } },
  { value: "c", label: { en: "Colourless (Eldrazi)", pt: "Incolor (Eldrazi)" } },
  { value: "v", label: { en: "Vehicle", pt: "Veículo" } },
];
const SECOND: Option[] = [{ value: "none", label: { en: "None", pt: "Nenhuma" } }, ...COLOR_OPTIONS.slice(1, 7)];
const LAND_COLOR: Option[] = [{ value: "none", label: { en: "Plain land", pt: "Terreno comum" } }, ...COLOR_OPTIONS.slice(1, 7)];
const RARITY: Option[] = [
  { value: "c", label: { en: "Common", pt: "Comum" } },
  { value: "u", label: { en: "Uncommon", pt: "Incomum" } },
  { value: "r", label: { en: "Rare", pt: "Rara" } },
  { value: "m", label: { en: "Mythic", pt: "Mítica" } },
  { value: "s", label: { en: "Special", pt: "Especial" } },
];
export const WATERMARKS = [
  "none", "w", "u", "b", "r", "g", "c", "misc-star", "guild-azorius", "guild-boros", "guild-dimir", "guild-golgari", "guild-gruul", "guild-izzet",
  "guild-orzhov", "guild-rakdos", "guild-selesnya", "guild-simic", "clan-abzan", "clan-jeskai", "clan-mardu", "clan-sultai", "clan-temur",
];
const WM_COLOR: Option[] = [
  { value: "auto", label: { en: "Frame colour", pt: "Cor da moldura" } },
  { value: "#000000", label: { en: "Black", pt: "Preto" } },
  { value: "#ffffff", label: { en: "White", pt: "Branco" } },
  { value: "#b48e3a", label: { en: "Gold", pt: "Dourado" } },
];
const WM_TINT: Record<string, string> = { w: "#b8a77a", u: "#3b6aa0", b: "#3a3330", r: "#a1402a", g: "#3c6b3a", m: "#b48e3a", a: "#7d8a92", l: "#8a6f4d", c: "#8c8580", v: "#7a5a3a" };

const f = (key: string, label: [string, string], kind: FieldDef["kind"], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: { en: label[0], pt: label[1] }, kind, ...extra });

const COMMON_TAIL: FieldDef[] = [
  f("art", ["Art", "Arte"], "image", { tab: "art" }),
  f("artist", ["Artist", "Artista"], "text", { tab: "art" }),
  f("frameColor", ["Frame colour", "Cor da moldura"], "select", { tab: "frame", options: COLOR_OPTIONS }),
  f("hybrid", ["Second colour (hybrid, right half)", "Segunda cor (híbrido, metade direita)"], "select", { tab: "frame", options: SECOND }),
  f("landColor", ["Land frame tint", "Tom da moldura de terreno"], "select", { tab: "frame", options: LAND_COLOR, when: (x) => autoFrame(x).main === "l" }),
  f("legendary", ["Legendary crown", "Coroa lendária"], "toggle", { tab: "frame" }),
  f("nyx", ["Nyx (enchantment creature)", "Nyx (criatura encantamento)"], "toggle", { tab: "frame" }),
  f("holoStamp", ["Holo stamp", "Selo holográfico"], "toggle", { tab: "frame" }),
  f("watermark", ["Watermark", "Marca d'água de lore"], "select", { tab: "frame", options: WATERMARKS.map((w) => ({ value: w, label: { en: w === "none" ? "None" : w, pt: w === "none" ? "Nenhuma" : w } })) }),
  f("watermarkColor", ["Watermark colour", "Cor da marca d'água"], "select", { tab: "frame", options: WM_COLOR, when: (x) => str(x.watermark, "none") !== "none" }),
  f("reminder", ["Reminder text", "Texto de lembrete"], "select", {
    tab: "frame",
    options: [
      { value: "italic", label: { en: "Italic", pt: "Itálico" } },
      { value: "keep", label: { en: "As typed", pt: "Como digitado" } },
      { value: "hide", label: { en: "Hide", pt: "Ocultar" } },
    ],
  }),
  f("setCode", ["Set code", "Código da coleção"], "set", { tab: "set", placeholder: "DMU" }),
  f("rarity", ["Rarity", "Raridade"], "select", { tab: "set", options: RARITY }),
  f("setSymbol", ["Custom set symbol", "Símbolo de coleção próprio"], "image", { tab: "set" }),
  f("number", ["Collector number", "Número de colecionador"], "text", { tab: "collector", placeholder: "0123" }),
  f("total", ["Set size", "Total da coleção"], "text", { tab: "collector", placeholder: "280" }),
  f("lang", ["Language", "Idioma"], "text", { tab: "collector", placeholder: "EN" }),
  f("collector", ["Show collector info", "Mostrar info de colecionador"], "toggle", { tab: "collector" }),
];

const NAME_COST: FieldDef[] = [
  f("name", ["Name", "Nome"], "text"),
  f("cost", ["Mana cost", "Custo de mana"], "cost", { placeholder: "{2}{R}{R}" }),
  f("typeLine", ["Type line", "Linha de tipo"], "text", { placeholder: "Creature — Dragon" }),
];

const RULES_FIELDS: FieldDef[] = [
  f("rules", ["Rules text", "Texto de regras"], "rich", { help: { en: "{T}, {2}{W} for symbols, *italic*, **bold**", pt: "{T}, {2}{W} para símbolos, *itálico*, **negrito**" } }),
  f("flavor", ["Flavour text", "Texto de ambientação"], "rich"),
];

const PT_FIELDS: FieldDef[] = [f("power", ["Power", "Força"], "text"), f("toughness", ["Toughness", "Resistência"], "text")];

const DEFAULTS: Record<string, FieldValue> = {
  name: "Shivan Dragon",
  cost: "{4}{R}{R}",
  typeLine: "Creature — Dragon",
  rules: "Flying (This creature can't be blocked except by creatures with flying or reach.)\n{R}: Shivan Dragon gets +1/+0 until end of turn.",
  flavor: "The undisputed master of the mountains of Shiv.",
  power: "5",
  toughness: "5",
  art: null,
  artist: "Artist Name",
  frameColor: "auto",
  hybrid: "none",
  landColor: "none",
  legendary: false,
  nyx: false,
  holoStamp: false,
  watermark: "none",
  watermarkColor: "auto",
  reminder: "italic",
  setCode: "",
  rarity: "r",
  setSymbol: null,
  number: "0001",
  total: "",
  lang: "EN",
  collector: true,
};

const CARD_TYPES: CardTypeDef[] = [
  {
    id: "regular",
    label: { en: "M15 regular", pt: "M15 regular" },
    description: { en: "Modern frame: creatures, spells, artifacts, lands", pt: "Moldura moderna: criaturas, mágicas, artefatos, terrenos" },
    thumb: P("img/frames/m15/new/r.png"),
    fields: [...NAME_COST, ...RULES_FIELDS, ...PT_FIELDS, ...COMMON_TAIL],
    defaults: DEFAULTS,
  },
  {
    id: "extended",
    label: { en: "Extended art", pt: "Arte estendida" },
    description: { en: "Art runs to the card edges behind the title", pt: "Arte até as bordas, atrás do título" },
    thumb: P("img/frames/m15/new/extended/u.png"),
    fields: [...NAME_COST, ...RULES_FIELDS, ...PT_FIELDS, ...COMMON_TAIL],
    defaults: { ...DEFAULTS, name: "Counterspell", cost: "{U}{U}", typeLine: "Instant", rules: "Counter target spell.", flavor: "", power: "", toughness: "" },
  },
  {
    id: "borderless",
    label: { en: "Borderless", pt: "Sem borda" },
    description: { en: "Full-bleed art with floating boxes and white text", pt: "Arte total com caixas flutuantes e texto branco" },
    thumb: P("img/frames/m15/borderless/m15GenericShowcaseFrameG.png"),
    fields: [...NAME_COST, ...RULES_FIELDS, ...PT_FIELDS, ...COMMON_TAIL],
    defaults: { ...DEFAULTS, name: "Llanowar Elves", cost: "{G}", typeLine: "Creature — Elf Druid", rules: "{T}: Add {G}.", flavor: "", power: "1", toughness: "1" },
  },
  {
    id: "planeswalker",
    label: { en: "Planeswalker", pt: "Planeswalker" },
    description: { en: "Loyalty abilities and starting loyalty", pt: "Habilidades de lealdade e lealdade inicial" },
    thumb: P("img/frames/planeswalker/regular/planeswalkerFrameU.png"),
    fields: [
      ...NAME_COST,
      f("abilities", ["Loyalty abilities", "Habilidades de lealdade"], "list", {
        max: 4,
        item: [f("cost", ["Cost", "Custo"], "text", { placeholder: "+1" }), f("text", ["Text", "Texto"], "rich")],
      }),
      f("loyalty", ["Starting loyalty", "Lealdade inicial"], "text"),
      ...COMMON_TAIL,
    ],
    defaults: {
      ...DEFAULTS,
      name: "Jace, the Mind Sculptor",
      cost: "{2}{U}{U}",
      typeLine: "Legendary Planeswalker — Jace",
      loyalty: "3",
      abilities: [
        { cost: "+2", text: "Look at the top card of target player's library. You may put that card on the bottom of that player's library." },
        { cost: "0", text: "Draw three cards, then put two cards from your hand on top of your library in any order." },
        { cost: "−1", text: "Return target creature to its owner's hand." },
        { cost: "−12", text: "Exile all cards from target player's library, then that player shuffles their hand into their library." },
      ],
      rules: "",
      flavor: "",
      power: "",
      toughness: "",
    },
  },
  {
    id: "token",
    label: { en: "Token", pt: "Ficha" },
    description: { en: "M15 token with large art", pt: "Ficha M15 com arte grande" },
    thumb: P("img/frames/token/m15/regular/w.png"),
    fields: [f("name", ["Name", "Nome"], "text"), f("typeLine", ["Type line", "Linha de tipo"], "text"), ...RULES_FIELDS, ...PT_FIELDS, ...COMMON_TAIL],
    defaults: { ...DEFAULTS, name: "Soldier", cost: "", typeLine: "Token Creature — Soldier", rules: "", flavor: "", power: "1", toughness: "1", frameColor: "w" },
  },
  {
    id: "basic",
    label: { en: "Basic land", pt: "Terreno básico" },
    description: { en: "Land frame with the big mana symbol", pt: "Moldura de terreno com o símbolo grande" },
    thumb: P("img/frames/m15/new/lg.png"),
    fields: [
      f("name", ["Name", "Nome"], "text"),
      f("typeLine", ["Type line", "Linha de tipo"], "text"),
      f("basic", ["Mana symbol", "Símbolo de mana"], "select", {
        options: ["w", "u", "b", "r", "g", "c"].map((c) => ({ value: c, label: { en: c.toUpperCase(), pt: c.toUpperCase() } })),
      }),
      ...COMMON_TAIL,
    ],
    defaults: { ...DEFAULTS, name: "Forest", cost: "", typeLine: "Basic Land — Forest", rules: "", flavor: "", power: "", toughness: "", basic: "g", rarity: "c" },
  },
];

// ---------------------------------------------------------------- build

const RARITY_FILL: Record<string, { stops: string[]; stroke: string }> = {
  c: { stops: ["#1a1718", "#1a1718"], stroke: "#ffffff" },
  u: { stops: ["#5f7480", "#c8dbe4", "#5f7480"], stroke: "#000000" },
  r: { stops: ["#8d6e2c", "#e2c77a", "#8d6e2c"], stroke: "#000000" },
  m: { stops: ["#b23a12", "#f6a12d", "#b23a12"], stroke: "#000000" },
  s: { stops: ["#5b2e7a", "#b07cc6", "#5b2e7a"], stroke: "#000000" },
};
export const rarityTint = (r: string) => RARITY_FILL[r] ?? RARITY_FILL.c;

function setSymbolAsset(f: Record<string, FieldValue>): string | null {
  const custom = str(f.setSymbol);
  if (custom) return custom;
  const code = str(f.setCode).trim().toLowerCase();
  return code ? urlAsset(`https://svgs.scryfall.io/sets/${encodeURIComponent(code)}.svg`) : null;
}

function rulesText(f: Record<string, FieldValue>): string {
  const rules = str(f.rules).trim();
  const flavor = str(f.flavor).trim();
  if (!flavor) return rules;
  const fl = flavor
    .split("\n")
    .map((l) => (l.trim() ? `*${l.trim()}*` : l))
    .join("\n");
  return rules ? `${rules}\n---\n${fl}` : fl;
}

function frameName(kind: "new" | "extended" | "nyx", c: FrameLetter, land: string) {
  const letter = c === "l" && land !== "none" ? `l${land}` : c;
  if (kind === "nyx" && ["w", "u", "b", "r", "g", "m", "a"].includes(c)) return P(`img/frames/m15/new/nyx/${c}.png`);
  if (kind === "extended") return P(`img/frames/m15/new/extended/${letter}.png`);
  return P(`img/frames/m15/new/${letter}.png`);
}

const ptLetter = (c: FrameLetter) => (c === "l" ? "C" : c.toUpperCase());

function collectorLayers(k: ReturnType<typeof kit>, f: Record<string, FieldValue>, white = true) {
  if (!bool(f.collector)) return [];
  const rarity = str(f.rarity, "c").toUpperCase();
  const num = str(f.number);
  const total = str(f.total);
  const line1 = [total ? `${num}/${total}` : num, rarity].filter(Boolean).join(" ");
  const line2 = [str(f.setCode).toUpperCase(), str(f.lang, "EN").toUpperCase()].filter(Boolean).join(" • ");
  const color = white ? "#ffffff" : "#111111";
  return [
    k.txt("collector1", "Colecionador", { x: 0.0647, y: 0.9325, w: 0.45, h: 0.018 }, line1, 0.0155, { ...SMALL, color, vAlign: "middle" }),
    k.txt("collector2", "Coleção · idioma · artista", { x: 0.0647, y: 0.9505, w: 0.6, h: 0.018 }, str(f.artist) ? `${line2}  {brush} ${str(f.artist)}` : line2, 0.0155, {
      ...SMALL,
      color,
      vAlign: "middle",
      symbols: "mtg",
      symbolScale: 1.1,
    }),
  ];
}

interface Geom {
  art: Box;
  title: Box;
  type: Box;
  rules: Box;
  pt: Box;
  ptBox: Box;
  manaCenter: number;
  setCenter: number;
  setRight: number;
  setH: number;
  white: boolean;
  /** Extended frames have a dark type bar. */
  whiteType?: boolean;
}

const M15: Geom = {
  art: { x: 0.0767, y: 0.1129, w: 0.8476, h: 0.4429 },
  title: { x: 0.0836, y: 0.0515, w: 0.8292, h: 0.0543 },
  type: { x: 0.0836, y: 0.5643, w: 0.8292, h: 0.0543 },
  rules: { x: 0.086, y: 0.6326, w: 0.828, h: 0.2875 },
  pt: { x: 0.7928, y: 0.902, w: 0.1367, h: 0.0372 },
  ptBox: { x: 0.7573, y: 0.8848, w: 0.188, h: 0.0733 },
  manaCenter: 0.0778,
  setCenter: 0.5914,
  setRight: 0.9264,
  setH: 0.041,
  white: false,
};
const EXTENDED: Geom = { ...M15, art: { x: 0, y: 236 / 2814, w: 1, h: 1530 / 2814 }, whiteType: true };
const BORDERLESS: Geom = {
  ...M15,
  art: { x: 0, y: 0, w: 1, h: 1 },
  title: { x: 0.0854, y: 0.0522, w: 0.8292, h: 0.0543 },
  type: { x: 0.0854, y: 0.5664, w: 0.8292, h: 0.0543 },
  rules: { x: 0.086, y: 0.6303, w: 0.828, h: 0.2875 },
  ptBox: { x: 1146 / 1500, y: 1861 / 2100, w: 274 / 1500, h: 140 / 2100 },
  manaCenter: 0.0613 + 0.0153,
  setCenter: 0.5935,
  white: true,
};

function nameCostType(k: ReturnType<typeof kit>, f: Record<string, FieldValue>, g: Geom, name = true) {
  const white = g.white ? "#ffffff" : "#111111";
  const cost = str(f.cost);
  const costW = Math.min(0.5, (cost.match(/\{/g)?.length ?? 0) * 0.036 + 0.01);
  const setA = setSymbolAsset(f);
  const tint = rarityTint(str(f.rarity, "c"));
  return layers(
    name &&
      k.txt("name", "Nome", { ...g.title, w: g.title.w - costW }, str(f.name), 0.0381, {
        ...TITLE,
        color: white,
        vAlign: "middle",
        autoFit: true,
        bind: "name",
      }),
    name &&
      !!cost &&
      k.txt("cost", "Custo de mana", { x: 0.5, y: g.manaCenter - 0.025, w: 0.9264 - 0.5, h: 0.05 }, cost, 0.0306 / 0.92, {
        ...TITLE,
        align: "right",
        vAlign: "middle",
        symbols: "mtg",
        symbolScale: 0.92,
        shadow: { color: "#000000", blur: 0, x: -0.06, y: 0.25 },
        bind: "cost",
      }),
    k.txt("type", "Linha de tipo", { ...g.type, w: g.type.w - (setA ? 0.07 : 0) }, str(f.typeLine), 0.0324, {
      ...TITLE,
      color: g.whiteType ? "#ffffff" : white,
      vAlign: "middle",
      autoFit: true,
      bind: "typeLine",
    }),
    !!setA &&
      k.img("set", "Símbolo da coleção", { x: g.setRight - 0.12, y: g.setCenter - g.setH / 2, w: 0.12, h: g.setH }, setA, {
        fit: "contain",
        offsetX: 1,
        overlay: str(f.setSymbol) ? null : { color: tint.stops[1], amount: str(f.rarity, "c") === "c" ? 0 : 1 },
        shadow: { color: tint.stroke === "#ffffff" ? "#ffffffcc" : "#000000cc", blur: 0.15, x: 0, y: 0 },
      }),
  );
}

function watermarkLayer(k: ReturnType<typeof kit>, f: Record<string, FieldValue>, frame: FrameLetter) {
  const wm = str(f.watermark, "none");
  if (wm === "none") return null;
  const col = str(f.watermarkColor, "auto");
  return k.img("watermark", "Marca d'água de lore", { x: 0.125, y: 0.661, w: 0.75, h: 0.2305 }, P(`img/watermarks/${wm}.svg`), {
    fit: "contain",
    opacity: 0.4,
    overlay: { color: col === "auto" ? WM_TINT[frame] ?? "#000" : col, amount: 1 },
  });
}

function buildRegular(state: TcgState, geo: { width: number; height: number; bleed: number }, variant: "regular" | "extended" | "borderless"): Layer[] {
  const f = state.fields;
  const k = kit(geo);
  const { main, second } = autoFrame(f);
  const land = str(f.landColor, "none");
  const g = variant === "extended" ? EXTENDED : variant === "borderless" ? BORDERLESS : M15;
  const nyx = bool(f.nyx) && variant === "regular";
  const frameOf = (c: FrameLetter) =>
    variant === "borderless" ? P(`img/frames/m15/borderless/m15GenericShowcaseFrame${(c === "v" ? "a" : c).toUpperCase()}.png`) : frameName(nyx ? "nyx" : variant === "extended" ? "extended" : "new", c, land);
  const creature = isCreature(f);
  const pt = `${str(f.power)}/${str(f.toughness)}`;
  const ptAsset =
    variant === "borderless"
      ? P(`img/frames/m15/borderless/pt/${main === "v" ? "a" : main}.png`)
      : P(`img/frames/m15/regular/m15PT${ptLetter(second ? (second as FrameLetter) : main)}.png`);
  const white = g.white ? "#ffffff" : "#111111";
  return layers(
    k.bleed("bg", "Borda", "#000000"),
    k.img("art", "Arte", g.art, str(f.art) || null, { bind: "art" }),
    k.frame("frame", "Moldura", frameOf(main)),
    !!second && k.frame("frame2", "Moldura (segunda cor)", frameOf(second as FrameLetter), { mask: P("img/frames/maskRightHalf.png") }),
    bool(f.legendary) && k.img("crown", "Coroa lendária", { x: 44 / 2010, y: 53 / 2814, w: 1922 / 2010, h: 493 / 2814 }, P(`img/frames/m15/crowns/new/${main === "v" ? "a" : main}.png`), { fit: "stretch", locked: true }),
    watermarkLayer(k, f, main),
    ...nameCostType(k, f, g),
    k.txt("rules", "Texto de regras", g.rules, rulesText(f), 0.0362, {
      ...RULES,
      color: white,
      vAlign: "middle",
      autoFit: true,
      lineHeight: 1.12,
      symbols: "mtg",
      symbolScale: 0.78,
      reminder: (str(f.reminder, "italic") as "italic") || "italic",
      bind: "rules",
    }),
    creature && k.img("ptBox", "Caixa F/R", g.ptBox, ptAsset, { fit: "stretch", locked: true }),
    creature && k.txt("pt", "Força/Resistência", variant === "borderless" ? { ...g.ptBox, y: g.ptBox.y + 0.004 } : g.pt, pt, 0.0372, { font: "Beleren Small Caps", fallback: "Cinzel", weight: 700, align: "center", vAlign: "middle", color: g.white ? "#ffffff" : "#111111" }),
    bool(f.holoStamp) && k.img("holo", "Selo holográfico", { x: 0.4667, y: 0.9195, w: 0.0667, h: 0.0333 }, P("img/frames/m15/holoStamps/stamp.png"), { fit: "contain" }),
    ...collectorLayers(k, f),
  );
}

function buildPlaneswalker(state: TcgState, geo: { width: number; height: number; bleed: number }): Layer[] {
  const f = state.fields;
  const k = kit(geo);
  let { main } = autoFrame(f);
  if (!["w", "u", "b", "r", "g", "m", "a"].includes(main)) main = "a";
  const abilities = rows(f.abilities).slice(0, 4);
  const top = 0.6239;
  const bottom = 0.885;
  const n = Math.max(1, abilities.length);
  const each = (bottom - top) / n;
  const pwGeom: Geom = {
    ...M15,
    title: { x: 0.0867, y: 0.0372, w: 0.8267, h: 0.0548 },
    type: { x: 0.0867, y: 0.5625, w: 0.8267, h: 0.0548 },
    manaCenter: 0.0481 + 0.0153,
    setCenter: 0.5891 + 0.0002,
    setRight: 0.9227,
    setH: 0.0381,
  };
  const out: (Layer | null | false)[] = [
    k.bleed("bg", "Borda", "#000000"),
    k.img("art", "Arte", { x: 0.068, y: 0.101, w: 0.864, h: 0.8143 }, str(f.art) || null, { bind: "art" }),
    k.frame("frame", "Moldura", P(`img/frames/planeswalker/regular/planeswalkerFrame${main.toUpperCase()}.png`)),
    ...nameCostType(k, f, pwGeom),
  ];
  abilities.forEach((a, i) => {
    const y = top + i * each;
    out.push(k.box(`band${i}`, `Faixa ${i + 1}`, { x: 0.068 + 0.012, y, w: 0.864 - 0.024, h: each }, i % 2 ? "#ffffff" : "#f2ece2", { opacity: i % 2 ? 0.62 : 0.74, locked: true }));
    const c = (a.cost ?? "").trim();
    if (c) {
      const icon = c.startsWith("+") ? "planeswalkerPlus" : c === "0" || c === "±0" ? "planeswalkerNeutral" : "planeswalkerMinus";
      const ih = 0.0481;
      out.push(k.img(`lcost${i}`, `Ícone de lealdade ${i + 1}`, { x: 0.031, y: y + each / 2 - ih / 2, w: 0.0933, h: ih }, P(`img/frames/planeswalker/${icon}.png`), { fit: "stretch", locked: true }));
      out.push(k.txt(`lcosttext${i}`, `Custo de lealdade ${i + 1}`, { x: 0.031, y: y + each / 2 - ih / 2, w: 0.0933, h: ih }, c.replace("-", "−"), 0.0286, { ...TITLE, color: "#ffffff", align: "center", vAlign: "middle" }));
    }
    out.push(
      k.txt(`ability${i}`, `Habilidade ${i + 1}`, { x: 0.18, y: y + 0.004, w: 0.7467, h: each - 0.008 }, a.text ?? "", 0.0353, {
        ...RULES,
        vAlign: "middle",
        autoFit: true,
        lineHeight: 1.1,
        symbols: "mtg",
        symbolScale: 0.78,
        reminder: (str(f.reminder, "italic") as "italic") || "italic",
      }),
    );
  });
  const loyalty = str(f.loyalty);
  if (loyalty) out.push(k.txt("loyalty", "Lealdade", { x: 0.806, y: 0.902, w: 0.14, h: 0.0372 }, loyalty, 0.0372, { font: "Beleren Small Caps", fallback: "Cinzel", weight: 700, color: "#ffffff", align: "center", vAlign: "middle" }));
  out.push(...collectorLayers(k, f));
  return layers(...out);
}

function buildToken(state: TcgState, geo: { width: number; height: number; bleed: number }): Layer[] {
  const f = state.fields;
  const k = kit(geo);
  let { main } = autoFrame(f);
  if (main === "c" || main === "v") main = "a";
  const creature = isCreature(f);
  const g: Geom = {
    ...M15,
    type: { x: 0.0836, y: 0.642, w: 0.8292, h: 0.0543 },
    rules: { x: 0.09, y: 0.712, w: 0.82, h: 0.19 },
    setCenter: 0.669,
  };
  return layers(
    k.bleed("bg", "Borda", "#000000"),
    k.img("art", "Arte", { x: 0.0767, y: 0.0629, w: 0.8476, h: 0.6 }, str(f.art) || null, { bind: "art" }),
    k.frame("frame", "Moldura", P(`img/frames/token/m15/regular/${main}.png`)),
    k.txt("name", "Nome", { x: 0.15, y: 0.051, w: 0.7, h: 0.0543 }, str(f.name), 0.0381, { ...TITLE, color: "#ffffff", align: "center", vAlign: "middle", autoFit: true, bind: "name" }),
    ...nameCostType(k, f, g, false),
    k.txt("rules", "Texto de regras", g.rules, rulesText(f), 0.0362, { ...RULES, vAlign: "middle", align: "center", autoFit: true, symbols: "mtg", symbolScale: 0.78, reminder: "italic", bind: "rules" }),
    creature && k.img("ptBox", "Caixa F/R", M15.ptBox, P(`img/frames/m15/regular/m15PT${ptLetter(main)}.png`), { fit: "stretch", locked: true }),
    creature && k.txt("pt", "Força/Resistência", M15.pt, `${str(f.power)}/${str(f.toughness)}`, 0.0372, { font: "Beleren Small Caps", fallback: "Cinzel", weight: 700, align: "center", vAlign: "middle" }),
    ...collectorLayers(k, f),
  );
}

function buildBasic(state: TcgState, geo: { width: number; height: number; bleed: number }): Layer[] {
  const f = state.fields;
  const k = kit(geo);
  const c = str(f.basic, "g");
  const land = c === "c" ? "" : c;
  return layers(
    k.bleed("bg", "Borda", "#000000"),
    k.img("art", "Arte", M15.art, str(f.art) || null, { bind: "art" }),
    k.frame("frame", "Moldura", P(`img/frames/m15/new/l${land}.png`)),
    ...nameCostType(k, { ...f, cost: "" }, M15),
    k.img("basicSymbol", "Símbolo de mana", { x: 0.3267, y: 0.6491, w: 0.3474, h: 0.2496 }, P(`img/frames/m15/basics/${c}.png`), { fit: "contain", locked: true }),
    ...collectorLayers(k, f),
  );
}

// ---------------------------------------------------------------- import

const RARITY_MAP: Record<string, string> = { common: "c", uncommon: "u", rare: "r", mythic: "m", special: "s", bonus: "s" };

/** Scryfall card JSON → fields. Double-faced cards use their front face. */
export function fromScryfall(raw: unknown): Imported | null {
  const c = raw as Record<string, any>;
  if (!c || typeof c !== "object" || !c.name) return null;
  const face = Array.isArray(c.card_faces) && c.card_faces.length ? { ...c, ...c.card_faces[0] } : c;
  const type = String(face.type_line ?? "");
  const isPw = /planeswalker/i.test(type);
  const isToken = /token/i.test(type) || c.layout === "token";
  const isBasic = /basic land/i.test(type);
  const fields: Record<string, FieldValue> = {
    ...DEFAULTS,
    name: face.name ?? "",
    cost: face.mana_cost ?? "",
    typeLine: type,
    rules: String(face.oracle_text ?? ""),
    flavor: String(face.flavor_text ?? ""),
    power: face.power ?? "",
    toughness: face.toughness ?? "",
    artist: face.artist ?? c.artist ?? "",
    setCode: String(c.set ?? "").toUpperCase(),
    rarity: RARITY_MAP[c.rarity] ?? "c",
    number: String(c.collector_number ?? ""),
    lang: String(c.lang ?? "en").toUpperCase(),
    legendary: /legendary/i.test(type),
    nyx: Array.isArray(c.frame_effects) && c.frame_effects.includes("nyxtouched"),
    watermark: c.watermark && WATERMARKS.some((w) => w.endsWith(c.watermark)) ? WATERMARKS.find((w) => w.endsWith(c.watermark))! : "none",
  };
  const art = face.image_uris?.art_crop ?? c.image_uris?.art_crop;
  if (art) fields.art = urlAsset(art);
  const scan = face.image_uris?.png ?? c.image_uris?.png ?? null;
  let cardType = "regular";
  if (isPw) {
    cardType = "planeswalker";
    fields.loyalty = face.loyalty ?? "";
    fields.abilities = String(face.oracle_text ?? "")
      .split("\n")
      .filter(Boolean)
      .slice(0, 4)
      .map((l) => {
        const m = /^([+−\-–]?\d+|0|[+−\-]X):\s*(.*)$/.exec(l);
        return m ? { cost: m[1].replace(/[-–]/, "−"), text: m[2] } : { cost: "", text: l };
      });
  } else if (isToken) cardType = "token";
  else if (isBasic) {
    cardType = "basic";
    const m = /(Plains|Island|Swamp|Mountain|Forest|Wastes)/.exec(type);
    fields.basic = m ? { Plains: "w", Island: "u", Swamp: "b", Mountain: "r", Forest: "g", Wastes: "c" }[m[1]]! : "c";
  } else if (Array.isArray(c.frame_effects) && c.frame_effects.includes("extendedart")) cardType = "extended";
  else if (c.border_color === "borderless") cardType = "borderless";
  return { cardType, fields, scanUrl: scan, name: face.name ?? c.name };
}

/** Oracle-style pasted text: "Name {cost}\nType\nRules…\nP/T". */
export function parseMtgText(text: string): Partial<Imported> | null {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) return null;
  const fields: Record<string, FieldValue> = {};
  const first = lines.shift()!;
  const cm = /^(.*?)\s*((?:\{[^}]+\})+)\s*$/.exec(first);
  fields.name = (cm ? cm[1] : first).trim();
  fields.cost = cm ? cm[2] : "";
  if (lines.length) fields.typeLine = lines.shift()!.trim();
  const last = lines[lines.length - 1]?.trim() ?? "";
  const pt = /^(\*|\d+|X)\s*\/\s*(\*|\d+|X)$/.exec(last);
  if (pt) {
    fields.power = pt[1];
    fields.toughness = pt[2];
    lines.pop();
  }
  const loyal = /^Loyalty:\s*(\d+)$/i.exec(last);
  if (loyal) {
    fields.loyalty = loyal[1];
    lines.pop();
  }
  const body = lines.join("\n").trim();
  const flavorIdx = body.search(/\n\*[^*]/);
  if (flavorIdx >= 0) {
    fields.rules = body.slice(0, flavorIdx).trim();
    fields.flavor = body.slice(flavorIdx).replace(/\*/g, "").trim();
  } else fields.rules = body;
  const isPw = /planeswalker/i.test(str(fields.typeLine));
  if (isPw) {
    fields.abilities = str(fields.rules)
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const m = /^([+−\-–]?\d+|0):\s*(.*)$/.exec(l);
        return m ? { cost: m[1], text: m[2] } : { cost: "", text: l };
      });
  }
  return { cardType: isPw ? "planeswalker" : undefined, fields, name: str(fields.name) };
}

const REAL_MASKS: RealMask[] = [
  { id: "name", label: "Nome", x: 0.075, y: 0.052, w: 0.62, h: 0.053, fill: "auto" },
  { id: "type", label: "Linha de tipo", x: 0.075, y: 0.565, w: 0.75, h: 0.052, fill: "auto" },
  { id: "rules", label: "Caixa de texto", x: 0.085, y: 0.63, w: 0.83, h: 0.255, fill: "auto" },
  { id: "pt", label: "F/R", x: 0.79, y: 0.9, w: 0.14, h: 0.042, fill: "auto" },
];

export const mtg: TcgProfile = {
  id: "mtg",
  name: "Magic: The Gathering",
  packId: "mtg",
  size: { width: 63, height: 88 },
  cardTypes: CARD_TYPES,
  symbols: ["W", "U", "B", "R", "G", "C", "X", "1", "2", "3", "T", "Q", "W/U", "W/P", "E", "S"].map((c) => ({ code: `{${c}}`, label: c })),
  build(state, geo) {
    switch (state.cardType) {
      case "planeswalker":
        return buildPlaneswalker(state, geo);
      case "token":
        return buildToken(state, geo);
      case "basic":
        return buildBasic(state, geo);
      case "extended":
      case "borderless":
        return buildRegular(state, geo, state.cardType);
      default:
        return buildRegular(state, geo, "regular");
    }
  },
  fromApi: fromScryfall,
  parsePaste: parseMtgText,
  realMasks: () => REAL_MASKS.map((m) => ({ ...m })),
};
