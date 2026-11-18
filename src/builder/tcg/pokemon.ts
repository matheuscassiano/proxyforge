// Pokémon TCG profile (Sword & Shield era). Frames and fonts come from the "pokemon" pack
// (pokecardmaker.net assets, 747×1038 px); placements follow its card styles, in card fractions.
import { packAsset, urlAsset } from "../assets";
import type { FieldValue, Layer, RealMask, TcgState } from "../types";
import { kit, layers, type Box } from "./kit";
import { POKEMON_COIN } from "./symbols";
import { bool, rows, str, type CardTypeDef, type FieldDef, type Imported, type Option, type TcgProfile } from "./types";

const ROOT = "public/assets/cards/baseSets/swordAndShield/supertypes";
const P = (path: string) => packAsset("pokemon", path);
const GILL = { font: "Gill Sans Std", fallback: "Montserrat", weight: 700 as const };
const GILL_COND = { font: "Gill Sans Condensed", fallback: "Oswald", weight: 700 as const };
const FUTURA = { font: "Futura Heavy", fallback: "Montserrat", weight: 700 as const };
const FRUTIGER = { font: "Frutiger", fallback: "Montserrat" };
const TEXT = { font: "Gill Sans Std", fallback: "Montserrat", weight: 400 as const };

/** 1 "em" of pokecardmaker's layout (16 px on a 747 px card), as a fraction of card height. */
const EM = (16 / 747) * (63 / 88);

const PT_NAMES: Record<string, string> = {
  grass: "Planta",
  fire: "Fogo",
  water: "Água",
  lightning: "Elétrico",
  psychic: "Psíquico",
  fighting: "Lutador",
  dark: "Escuridão",
  metal: "Metal",
  colorless: "Incolor",
  dragon: "Dragão",
  fairy: "Fada",
};
export const TYPES = Object.keys(POKEMON_COIN);
const TYPE_OPTIONS: Option[] = TYPES.map((t) => ({ value: t, label: { en: t[0].toUpperCase() + t.slice(1), pt: PT_NAMES[t] ?? t } }));
const NONE: Option = { value: "none", label: { en: "None", pt: "Nenhuma" } };

const f = (key: string, label: [string, string], kind: FieldDef["kind"], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: { en: label[0], pt: label[1] }, kind, ...extra });

const ATTACK_ITEM: FieldDef[] = [
  f("cost", ["Energy cost", "Custo de energia"], "text", { placeholder: "{R}{C}" }),
  f("name", ["Name", "Nome"], "text"),
  f("damage", ["Damage", "Dano"], "text", { placeholder: "90+" }),
  f("text", ["Effect", "Efeito"], "rich"),
];

const INFO: FieldDef[] = [
  f("art", ["Art", "Arte"], "image", { tab: "art" }),
  f("illustrator", ["Illustrator", "Ilustrador"], "text", { tab: "art" }),
  f("setSymbol", ["Set symbol", "Símbolo da coleção"], "image", { tab: "set" }),
  f("setId", ["TCGdex set id (symbol)", "ID do set no TCGdex (símbolo)"], "set", { tab: "set", placeholder: "swsh7" }),
  f("number", ["Card number", "Número"], "text", { tab: "collector", placeholder: "025/203" }),
  f("rarity", ["Rarity icon", "Ícone de raridade"], "select", {
    tab: "collector",
    options: [NONE, { value: "common", label: { en: "Common ●", pt: "Comum ●" } }, { value: "uncommon", label: { en: "Uncommon ◆", pt: "Incomum ◆" } }, { value: "rare", label: { en: "Rare ★", pt: "Rara ★" } }],
  }),
  f("regulation", ["Regulation mark", "Marca de regulação"], "select", {
    tab: "collector",
    options: [NONE, ...["d", "e", "f"].map((v) => ({ value: v, label: { en: v.toUpperCase(), pt: v.toUpperCase() } }))],
  }),
];

const POKEMON_FIELDS: FieldDef[] = [
  f("name", ["Name", "Nome"], "text"),
  f("hp", ["HP", "PS"], "text"),
  f("type", ["Type", "Tipo"], "select", { options: TYPE_OPTIONS }),
  f("variation", ["Frame variation", "Variação da moldura"], "select", {
    tab: "frame",
    options: [NONE, { value: "ex", label: { en: "ex (white)", pt: "ex (branca)" } }, { value: "dark", label: { en: "Dark", pt: "Escura" } }, { value: "light", label: { en: "Light", pt: "Clara" } }],
  }),
  f("evolvesFrom", ["Evolves from", "Evolui de"], "text", { when: (x) => ["stage1", "stage2"].includes(str(x._type)) }),
  f("prevolveArt", ["Pre-evolution picture", "Imagem da pré-evolução"], "image", { tab: "art", when: (x) => ["stage1", "stage2"].includes(str(x._type)) }),
  f("dex", ["Dex stats", "Dados da Pokédex"], "text", { placeholder: "NO. 006 Flame Pokémon HT: 5'7\" WT: 199.5 lbs." }),
  f("abilityName", ["Ability name", "Nome da habilidade"], "text"),
  f("abilityText", ["Ability text", "Texto da habilidade"], "rich", { when: (x) => !!str(x.abilityName) }),
  f("attacks", ["Attacks", "Ataques"], "list", { max: 3, item: ATTACK_ITEM }),
  f("weakness", ["Weakness", "Fraqueza"], "select", { options: [NONE, ...TYPE_OPTIONS] }),
  f("weaknessAmount", ["Weakness amount", "Valor da fraqueza"], "text", { placeholder: "×2" }),
  f("resistance", ["Resistance", "Resistência"], "select", { options: [NONE, ...TYPE_OPTIONS] }),
  f("resistanceAmount", ["Resistance amount", "Valor da resistência"], "text", { placeholder: "-30" }),
  f("retreat", ["Retreat cost", "Custo de recuo"], "number"),
  f("dexEntry", ["Pokédex entry", "Entrada da Pokédex"], "rich"),
  ...INFO,
];

const POKEMON_DEFAULTS: Record<string, FieldValue> = {
  name: "Charmander",
  hp: "70",
  type: "fire",
  variation: "none",
  evolvesFrom: "",
  prevolveArt: null,
  dex: "NO. 004 Lizard Pokémon HT: 2' WT: 18.7 lbs.",
  abilityName: "",
  abilityText: "",
  attacks: [
    { cost: "{R}", name: "Ember", damage: "30", text: "Discard an Energy from this Pokémon." },
    { cost: "{R}{C}", name: "Flare", damage: "40", text: "" },
  ],
  weakness: "water",
  weaknessAmount: "×2",
  resistance: "none",
  resistanceAmount: "",
  retreat: 1,
  dexEntry: "It has a preference for hot things. When it rains, steam is said to spout from the tip of its tail.",
  art: null,
  illustrator: "Illustrator",
  setSymbol: null,
  setId: "",
  number: "004/198",
  rarity: "common",
  regulation: "e",
};

const TRAINER_FIELDS: FieldDef[] = [
  f("name", ["Name", "Nome"], "text"),
  f("trainerKind", ["Trainer type", "Tipo de treinador"], "select", {
    options: [
      { value: "item", label: { en: "Item", pt: "Item" } },
      { value: "tool", label: { en: "Pokémon Tool", pt: "Ferramenta Pokémon" } },
      { value: "supporter", label: { en: "Supporter", pt: "Apoiador" } },
      { value: "stadium", label: { en: "Stadium", pt: "Estádio" } },
    ],
  }),
  f("text", ["Card text", "Texto da carta"], "rich"),
  f("rule", ["Rule text", "Texto de regra"], "rich", { help: { en: "Extra small text at the bottom (the Supporter/Stadium/Tool rule is already printed on the frame)", pt: "Texto pequeno extra no rodapé (a regra de Apoiador/Estádio/Ferramenta já vem na moldura)" } }),
  ...INFO,
];

const ENERGY_FIELDS: FieldDef[] = [
  f("name", ["Name", "Nome"], "text"),
  f("type", ["Energy type", "Tipo de energia"], "select", { options: TYPE_OPTIONS }),
  f("special", ["Special energy", "Energia especial"], "toggle"),
  f("text", ["Card text", "Texto da carta"], "rich", { when: (x) => bool(x.special) }),
  ...INFO,
];

const STAGE_SUB: Record<string, string> = { basic: "basic", stage1: "stage1", stage2: "stage2", v: "v", vmax: "vmax", vstar: "vstar" };

const CARD_TYPES: CardTypeDef[] = [
  ...(["basic", "stage1", "stage2", "v", "vmax", "vstar"] as const).map(
    (id): CardTypeDef => ({
      id,
      label: { en: { basic: "Basic Pokémon", stage1: "Stage 1", stage2: "Stage 2", v: "Pokémon V", vmax: "Pokémon VMAX", vstar: "Pokémon VSTAR" }[id], pt: { basic: "Pokémon Básico", stage1: "Estágio 1", stage2: "Estágio 2", v: "Pokémon V", vmax: "Pokémon VMAX", vstar: "Pokémon V-ASTRO" }[id] },
      description: { en: "Sword & Shield frame", pt: "Moldura Espada e Escudo" },
      thumb: P(`${ROOT}/pokemon/types/${id === "vmax" ? "fire" : "grass"}/subtypes/${id === "vmax" ? "vmax/variations/dynamax" : id}.png`),
      fields: [
        ...POKEMON_FIELDS.filter((x) => !(["v", "vmax", "vstar"].includes(id) && ["variation", "dex", "dexEntry"].includes(x.key))),
        ...(id === "vmax"
          ? [f("vmaxStyle", ["VMAX style", "Estilo VMAX"], "select", { tab: "frame", options: [{ value: "dynamax", label: { en: "Dynamax", pt: "Dynamax" } }, { value: "gigantamax", label: { en: "Gigantamax", pt: "Gigantamax" } }] })]
          : []),
        ...(id === "v" ? [f("fullArt", ["Full art", "Arte total"], "toggle", { tab: "frame" })] : []),
      ],
      defaults: {
        ...POKEMON_DEFAULTS,
        _type: id,
        ...(id === "stage1" ? { name: "Charmeleon", hp: "90", evolvesFrom: "Charmander" } : {}),
        ...(id === "stage2" ? { name: "Charizard", hp: "170", evolvesFrom: "Charmeleon" } : {}),
        ...(["v", "vmax", "vstar"].includes(id)
          ? {
              name: id === "v" ? "Charizard V" : id === "vmax" ? "Charizard VMAX" : "Charizard VSTAR",
              hp: id === "v" ? "220" : id === "vmax" ? "330" : "280",
              dex: "",
              dexEntry: "",
              evolvesFrom: id === "vmax" ? "Charizard V" : "",
              vmaxStyle: "gigantamax",
              fullArt: false,
              attacks: [{ cost: "{R}{R}{C}", name: "Claw Slash", damage: "100", text: "" }, { cost: "{R}{R}{C}{C}", name: "Fire Spin", damage: "220", text: "Discard 2 Energy from this Pokémon." }],
              rule:
                id === "v"
                  ? "**V rule:** When your Pokémon V is Knocked Out, your opponent takes 2 Prize cards."
                  : id === "vmax"
                    ? "**VMAX rule:** When your Pokémon VMAX is Knocked Out, your opponent takes 3 Prize cards."
                    : "**VSTAR rule:** When your Pokémon VSTAR is Knocked Out, your opponent takes 2 Prize cards.",
            }
          : {}),
      },
    }),
  ),
  {
    id: "trainer",
    label: { en: "Trainer", pt: "Treinador" },
    description: { en: "Item, Tool, Supporter or Stadium", pt: "Item, Ferramenta, Apoiador ou Estádio" },
    thumb: P(`${ROOT}/trainer/types/supporter.png`),
    fields: TRAINER_FIELDS,
    defaults: {
      name: "Professor's Research",
      trainerKind: "supporter",
      text: "Discard your hand and draw 7 cards.",
      rule: "",
      art: null,
      illustrator: "Illustrator",
      setSymbol: null,
      setId: "",
      number: "178/202",
      rarity: "rare",
      regulation: "d",
    },
  },
  {
    id: "energy",
    label: { en: "Energy", pt: "Energia" },
    description: { en: "Basic or special Energy", pt: "Energia básica ou especial" },
    thumb: P(`${ROOT}/energy/types/special.png`),
    fields: ENERGY_FIELDS,
    defaults: { name: "Fire Energy", type: "fire", special: false, text: "", art: null, illustrator: "", setSymbol: null, setId: "", number: "", rarity: "none", regulation: "none" },
  },
];

// ---------------------------------------------------------------- build

const energyText = (code: string) => (code ? code : "");

function frameFor(state: TcgState): string {
  const f = state.fields;
  const t = str(f.type, "colorless");
  switch (state.cardType) {
    case "trainer": {
      const k = str(f.trainerKind, "item");
      return P(k === "tool" ? `${ROOT}/trainer/types/item/subtypes/tool.png` : `${ROOT}/trainer/types/${k}.png`);
    }
    case "energy":
      return P(`${ROOT}/energy/types/${bool(f.special) ? "special" : "base"}.png`);
    case "vmax":
      return P(`${ROOT}/pokemon/types/${t}/subtypes/vmax/variations/${str(f.vmaxStyle, "dynamax")}.png`);
    case "v":
      return P(bool(f.fullArt) && t !== "dragon" && t !== "fairy" ? `${ROOT}/pokemon/types/${t}/subtypes/v/rarities/fullArt.png` : `${ROOT}/pokemon/types/${t}/subtypes/v.png`);
    case "vstar":
      return P(`${ROOT}/pokemon/types/${t}/subtypes/vstar.png`);
    default: {
      const sub = STAGE_SUB[state.cardType] ?? "basic";
      const v = str(f.variation, "none");
      return P(v !== "none" ? `${ROOT}/pokemon/types/${t}/subtypes/${sub}/variations/${v}.png` : `${ROOT}/pokemon/types/${t}/subtypes/${sub}.png`);
    }
  }
}

function setSymbol(f: Record<string, FieldValue>) {
  const custom = str(f.setSymbol);
  if (custom) return custom;
  const id = str(f.setId).trim();
  if (!id) return null;
  const serie = id.replace(/\d.*$/, "").replace(/pt\d?$/, "") || id;
  return urlAsset(`https://assets.tcgdex.net/univ/${serie}/${id}/symbol.png`);
}

/** Rough text height in card fractions (used to stack attacks like pokecardmaker's flex layout). */
function textHeight(text: string, sizeFrac: number, widthFrac: number) {
  if (!text.trim()) return 0;
  const charW = sizeFrac * 0.5 * (88 / 63); // average glyph ≈ 0.5 em, in width fractions
  const perLine = Math.max(8, Math.floor(widthFrac / charW));
  const lines = text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  return lines * sizeFrac * 1.18;
}

function bottomInfo(k: ReturnType<typeof kit>, f: Record<string, FieldValue>, white: boolean): (Layer | null | false)[] {
  const color = white ? "#ffffff" : "#111111";
  const reg = str(f.regulation, "none");
  const sym = setSymbol(f);
  const rarity = str(f.rarity, "none");
  const y = 0.937;
  let x = 0.066;
  const out: (Layer | null | false)[] = [];
  out.push(k.txt("illus", "Ilustrador", { x: 0.066, y: 0.915, w: 0.5, h: 0.02 }, str(f.illustrator) ? `Illus. ${str(f.illustrator)}` : "", 0.81 * EM, { font: "Futura Bold Oblique", fallback: "Montserrat", weight: 700, italic: true, color, vAlign: "middle", bind: undefined }));
  if (reg !== "none") {
    out.push(k.img("regulation", "Marca de regulação", { x, y, w: 0.034, h: 0.024 }, P(`public/assets/icons/rotations/${reg}.png`), { fit: "contain", offsetX: -1 }));
    x += 0.04;
  }
  if (sym) {
    out.push(k.img("set", "Símbolo da coleção", { x, y: y - 0.002, w: 0.04, h: 0.028 }, sym, { fit: "contain", offsetX: -1 }));
    x += 0.046;
  }
  const num = str(f.number);
  if (num) out.push(k.txt("number", "Número", { x, y, w: 0.2, h: 0.024 }, num, 1.15 * EM, { ...FRUTIGER, weight: 700, italic: true, color, vAlign: "middle" }));
  if (rarity !== "none") {
    const nx = x + Math.max(0.06, num.length * 0.0165);
    out.push(k.img("rarity", "Raridade", { x: nx, y: y + 0.004, w: 0.018, h: 0.016 }, P(`public/assets/icons/rarities/${white ? "white/" : ""}${rarity}.png`), { fit: "contain" }));
  }
  return out;
}

function buildPokemon(state: TcgState, geo: { width: number; height: number; bleed: number }): Layer[] {
  const f = state.fields;
  const k = kit(geo);
  const id = state.cardType;
  const big = ["v", "vmax", "vstar"].includes(id);
  const fullArt = (id === "v" && bool(f.fullArt)) || id === "vmax" || id === "vstar";
  const frame = frameFor(state);
  const white = big; // V/VMAX/VSTAR use white HP and type bar text
  const type = str(f.type, "colorless");
  const art: Box = fullArt ? { x: 0, y: 0, w: 1, h: 1 } : big ? { x: 0.04, y: 0.09, w: 0.92, h: 0.45 } : { x: 0.085, y: 0.111, w: 0.83, h: 0.386 };
  const evolves = ["stage1", "stage2", "vmax"].includes(id) && !!str(f.evolvesFrom);
  const nameLeft = id === "basic" ? 0.19 : id === "stage1" || id === "stage2" ? 0.19 : 0.065;
  const hp = str(f.hp);
  const hpNumW = hp.length * 0.032;
  const out: (Layer | null | false)[] = [
    k.frameBleed("bleed", frame),
    k.img("art", "Arte", art, str(f.art) || null, { bind: "art" }),
    k.frame("frame", "Moldura", frame),
    evolves && id !== "vmax" && k.img("prevolve", "Pré-evolução", { x: 0.046, y: 0.079, w: 0.11, h: 0.08 }, str(f.prevolveArt) || null, { radius: 1.6, bind: "prevolveArt" }),
    evolves && k.txt("evolves", "Evolui de", { x: 0.178, y: 0.093, w: 0.5, h: 0.02 }, `Evolves from ${str(f.evolvesFrom)}`, 1.0125 * EM, { ...FRUTIGER, weight: 700, italic: true, color: white ? "#ffffff" : "#111111", vAlign: "middle" }),
    k.txt("name", "Nome", { x: nameLeft, y: 0.028, w: 0.6 - nameLeft + 0.12, h: 0.058 }, str(f.name), 3.125 * EM, { ...GILL, color: big ? "#ffffff" : "#111111", vAlign: "middle", autoFit: true, letterSpacing: -0.03, bind: "name", stroke: big ? { color: "#000000", width: 0.18 } : null }),
    !!hp && k.txt("hpNum", "PS", { x: 0.868 - hpNumW - 0.02, y: 0.026, w: hpNumW + 0.02, h: 0.058 }, hp, (big ? 3.55 : 2.7) * EM, { ...FUTURA, color: white ? "#ffffff" : "#111111", align: "right", vAlign: "middle", letterSpacing: -0.05, bind: "hp" }),
    !!hp && k.txt("hpLabel", "Rótulo PS", { x: 0.868 - hpNumW - 0.075, y: 0.036, w: 0.05, h: 0.04 }, "HP", (big ? 1 : 1.0625) * EM, { font: "Gill Sans Ultra", fallback: "Montserrat", weight: 700, color: white ? "#ffffff" : "#111111", align: "right", vAlign: "middle" }),
    k.txt("typeIcon", "Tipo", { x: 0.868, y: 0.026, w: 0.09, h: 0.058 }, `{${type}}`, 0.062 / 0.92 * 0.92, { symbols: "pokemon", symbolScale: 0.95, align: "center", vAlign: "middle" }),
    !big && !!str(f.dex) && k.txt("dex", "Dados da Pokédex", { x: 0.11, y: 0.482, w: 0.78, h: 0.018 }, str(f.dex), 0.92 * EM, { ...FRUTIGER, weight: 700, italic: true, align: "center", vAlign: "middle" }),
  ];

  // ability + attacks, stacked top-down (bottom-up for V cards)
  const movesTop = big ? 0.6 : 0.53;
  const movesBottom = big ? 0.845 : 0.835;
  const blocks: { h: number; build: (y: number) => (Layer | false)[] }[] = [];
  const textSize = 1.38 * EM;
  if (str(f.abilityName)) {
    const t = str(f.abilityText);
    const th = textHeight(t, textSize, 0.84);
    blocks.push({
      h: 0.045 + th,
      build: (y) => [
        k.box("abilityBadge", "Selo de habilidade", { x: 0.07, y: y + 0.008, w: 0.15, h: 0.03 }, "#c8102e", { radius: 0.8 }),
        k.txt("abilityLabel", "Habilidade", { x: 0.07, y: y + 0.008, w: 0.15, h: 0.03 }, "Ability", 1.5 * EM, { ...GILL_COND, italic: true, color: "#ffffff", align: "center", vAlign: "middle" }),
        k.txt("abilityName", "Nome da habilidade", { x: 0.235, y, w: 0.7, h: 0.045 }, str(f.abilityName), 2.625 * EM, { ...GILL_COND, color: "#c8102e", vAlign: "middle", autoFit: true, bind: "abilityName" }),
        !!t && k.txt("abilityText", "Texto da habilidade", { x: 0.08, y: y + 0.045, w: 0.84, h: th + 0.004 }, t, textSize, { ...TEXT, color: big ? "#111111" : "#111111", lineHeight: 1.12, symbols: "pokemon", symbolScale: 0.8, bind: "abilityText", autoFit: true }),
      ],
    });
  }
  rows(f.attacks)
    .slice(0, 3)
    .forEach((a, i) => {
      const t = a.text ?? "";
      const th = textHeight(t, textSize, 0.84);
      const costN = (a.cost?.match(/\{/g) ?? []).length;
      const costW = Math.max(2, costN) * 0.064 + 0.006;
      const nameX = 0.065 + costW + 0.01;
      blocks.push({
        h: 0.048 + th,
        build: (y) => [
          k.txt(`atkCost${i}`, `Custo do ataque ${i + 1}`, { x: 0.065, y, w: costW, h: 0.048 }, energyText(a.cost ?? ""), 0.043 / 0.92, { symbols: "pokemon", symbolScale: 0.92, vAlign: "middle" }),
          k.txt(`atkName${i}`, `Nome do ataque ${i + 1}`, { x: nameX, y, w: 0.78 - nameX, h: 0.048 }, a.name ?? "", 2.625 * EM, { ...GILL_COND, vAlign: "middle", autoFit: true, letterSpacing: -0.04 }),
          k.txt(`atkDmg${i}`, `Dano do ataque ${i + 1}`, { x: 0.76, y, w: 0.18, h: 0.048 }, a.damage ?? "", 2.2 * EM, { ...FUTURA, align: "right", vAlign: "middle" }),
          !!t && k.txt(`atkText${i}`, `Efeito do ataque ${i + 1}`, { x: 0.08, y: y + 0.048, w: 0.84, h: th + 0.004 }, t, textSize, { ...TEXT, lineHeight: 1.12, symbols: "pokemon", symbolScale: 0.8, autoFit: true }),
        ],
      });
    });
  const gap = 0.012;
  const total = blocks.reduce((s, b) => s + b.h, 0) + gap * Math.max(0, blocks.length - 1);
  let y = big ? movesBottom - total : movesTop + Math.max(0, (movesBottom - movesTop - total) / 2 - 0.02);
  for (const b of blocks) {
    out.push(...b.build(y));
    y += b.h + gap;
  }

  // type bar: weakness / resistance / retreat
  const barY = 0.857;
  const barH = 0.03;
  const barColor = white ? "#ffffff" : "#111111";
  const weak = str(f.weakness, "none");
  const res = str(f.resistance, "none");
  const retreat = Math.max(0, Math.min(5, Number(f.retreat) || 0));
  if (weak !== "none")
    out.push(k.txt("weakness", "Fraqueza", { x: 0.16, y: barY, w: 0.2, h: barH }, `{${weak}} ${str(f.weaknessAmount, "×2")}`, 0.026 / 0.92, { ...FUTURA, color: barColor, vAlign: "middle", symbols: "pokemon", symbolScale: 0.92 }));
  if (res !== "none")
    out.push(k.txt("resistance", "Resistência", { x: 0.419, y: barY, w: 0.2, h: barH }, `{${res}} ${str(f.resistanceAmount, "-30")}`, 0.026 / 0.92, { ...FUTURA, color: barColor, vAlign: "middle", symbols: "pokemon", symbolScale: 0.92 }));
  if (retreat)
    out.push(k.txt("retreat", "Recuo", { x: 0.723, y: barY, w: 0.204, h: barH }, Array.from({ length: retreat }, () => "{colorless}").join(""), 0.026 / 0.92, { color: barColor, vAlign: "middle", align: "left", symbols: "pokemon", symbolScale: 0.92 }));

  if (big && str(f.rule)) out.push(k.txt("rule", "Regra", { x: 0.07, y: 0.893, w: 0.86, h: 0.022 }, str(f.rule), 0.95 * EM, { ...TEXT, color: "#ffffff", align: "center", vAlign: "middle", autoFit: true }));
  if (!big && str(f.dexEntry))
    out.push(k.txt("dexEntry", "Entrada da Pokédex", { x: 0.355, y: 0.895, w: 0.58, h: 0.06 }, str(f.dexEntry), 1.03 * EM, { font: "Optima", fallback: "Lora", align: "right", vAlign: "bottom", autoFit: true, lineHeight: 1.2 }));
  out.push(...bottomInfo(k, f, white));
  if (!fullArt) out.push(copyrightCover(k));
  return layers(...out);
}

/** The pack frames carry a copyright/credit line on the bottom border; the proxy mark goes there instead. */
function copyrightCover(k: ReturnType<typeof kit>) {
  return k.box("copyrightCover", "Cobertura do rodapé", { x: 0.2, y: 0.974, w: 0.6, h: 0.02 }, "#f4cf4f", { locked: true });
}

function buildTrainer(state: TcgState, geo: { width: number; height: number; bleed: number }): Layer[] {
  const f = state.fields;
  const k = kit(geo);
  const frame = frameFor(state);
  const kind = str(f.trainerKind, "item");
  return layers(
    k.frameBleed("bleed", frame),
    k.img("art", "Arte", { x: 0.115, y: 0.146, w: 0.77, h: 0.354 }, str(f.art) || null, { bind: "art" }),
    k.frame("frame", "Moldura", frame),
    k.txt("name", "Nome", { x: 0.063, y: 0.063, w: 0.873, h: 0.058 }, str(f.name), 3.125 * EM, { ...GILL, vAlign: "middle", autoFit: true, letterSpacing: -0.03, bind: "name" }),
    k.txt("text", "Texto", kind === "tool" ? { x: 0.119, y: 0.61, w: 0.77, h: 0.2 } : { x: 0.119, y: 0.54, w: 0.77, h: 0.28 }, str(f.text), 1.6 * EM, { ...TEXT, vAlign: "middle", autoFit: true, lineHeight: 1.25, symbols: "pokemon", symbolScale: 0.85, bind: "text" }),
    !!str(f.rule) && k.txt("rule", "Regra", { x: 0.1, y: 0.86, w: 0.8, h: 0.04 }, str(f.rule), 1.05 * EM, { ...TEXT, align: "center", vAlign: "middle", autoFit: true }),
    ...bottomInfo(k, f, false),
    copyrightCover(k),
  );
}

function buildEnergy(state: TcgState, geo: { width: number; height: number; bleed: number }): Layer[] {
  const f = state.fields;
  const k = kit(geo);
  const frame = frameFor(state);
  const special = bool(f.special);
  const type = str(f.type, "fire");
  return layers(
    k.frameBleed("bleed", frame),
    special && k.img("art", "Arte", { x: 0.115, y: 0.146, w: 0.77, h: 0.45 }, str(f.art) || null, { bind: "art" }),
    k.frame("frame", "Moldura", frame),
    k.txt("name", "Nome", { x: 0.063, y: 0.063, w: 0.625, h: 0.058 }, str(f.name), 3.125 * EM, { ...GILL, vAlign: "middle", autoFit: true, bind: "name" }),
    !special && k.txt("bigSymbol", "Símbolo de energia", { x: 0.2, y: 0.24, w: 0.6, h: 0.43 }, `{${type}}`, 0.43 / 0.96, { symbols: "pokemon", symbolScale: 0.96, align: "center", vAlign: "middle" }),
    k.txt("cornerSymbol", "Símbolo do canto", { x: 0.81, y: 0.06, w: 0.12, h: 0.065 }, `{${type}}`, 0.06 / 0.92, { symbols: "pokemon", symbolScale: 0.92, align: "center", vAlign: "middle" }),
    special && !!str(f.text) && k.txt("text", "Texto", { x: 0.089, y: 0.656, w: 0.83, h: 0.2 }, str(f.text), 1.6 * EM, { ...TEXT, vAlign: "middle", autoFit: true, lineHeight: 1.25, symbols: "pokemon", symbolScale: 0.85, bind: "text" }),
    ...bottomInfo(k, f, false),
    copyrightCover(k),
  );
}

// ---------------------------------------------------------------- import

const TCGDEX_TYPE: Record<string, string> = { Grass: "grass", Fire: "fire", Water: "water", Lightning: "lightning", Psychic: "psychic", Fighting: "fighting", Darkness: "dark", Metal: "metal", Colorless: "colorless", Dragon: "dragon", Fairy: "fairy" };
const costOf = (cost: unknown) => (Array.isArray(cost) ? cost.map((c) => `{${TCGDEX_TYPE[String(c)] ?? "colorless"}}`).join("") : "");

/** TCGdex card JSON → fields. */
export function fromTcgdex(raw: unknown): Imported | null {
  const c = raw as Record<string, any>;
  if (!c || typeof c !== "object" || !c.name) return null;
  const number = c.set?.cardCount?.official ? `${c.localId}/${String(c.set.cardCount.official).padStart(3, "0")}` : String(c.localId ?? "");
  const scan = c.image ? `${c.image}/high.png` : null;
  const common = {
    name: c.name,
    illustrator: c.illustrator ?? "",
    setId: c.set?.id ?? "",
    number,
    rarity: /rare/i.test(c.rarity ?? "") ? "rare" : /uncommon/i.test(c.rarity ?? "") ? "uncommon" : /common/i.test(c.rarity ?? "") ? "common" : "none",
    regulation: ["d", "e", "f"].includes(String(c.regulationMark ?? "").toLowerCase()) ? String(c.regulationMark).toLowerCase() : "none",
    art: null,
    setSymbol: null,
  };
  if (c.category === "Trainer") {
    const kind = /supporter/i.test(c.trainerType ?? "") ? "supporter" : /stadium/i.test(c.trainerType ?? "") ? "stadium" : /tool/i.test(c.trainerType ?? "") ? "tool" : "item";
    return { cardType: "trainer", name: c.name, scanUrl: scan, fields: { ...CARD_TYPES.find((t) => t.id === "trainer")!.defaults, ...common, trainerKind: kind, text: c.effect ?? "" } };
  }
  if (c.category === "Energy") {
    const type = TCGDEX_TYPE[(c.name as string).split(" ")[0]] ?? "colorless";
    return { cardType: "energy", name: c.name, scanUrl: scan, fields: { ...common, type, special: c.energyType === "Special", text: c.effect ?? "" } };
  }
  const stage = String(c.stage ?? "Basic").toLowerCase();
  const suffix = String(c.suffix ?? "").toUpperCase();
  const cardType = suffix === "VMAX" || stage === "vmax" ? "vmax" : suffix === "VSTAR" || stage === "vstar" ? "vstar" : suffix === "V" ? "v" : stage.includes("2") ? "stage2" : stage.includes("1") ? "stage1" : "basic";
  const def = CARD_TYPES.find((t) => t.id === cardType)!.defaults;
  const ability = Array.isArray(c.abilities) ? c.abilities[0] : null;
  return {
    cardType,
    name: c.name,
    scanUrl: scan,
    fields: {
      ...def,
      ...common,
      hp: String(c.hp ?? ""),
      type: TCGDEX_TYPE[c.types?.[0]] ?? "colorless",
      evolvesFrom: c.evolveFrom ?? "",
      dex: c.dexId?.[0] ? `NO. ${String(c.dexId[0]).padStart(3, "0")}` : "",
      dexEntry: c.description ?? "",
      abilityName: ability?.name ?? "",
      abilityText: ability?.effect ?? "",
      attacks: (c.attacks ?? []).slice(0, 3).map((a: any) => ({ cost: costOf(a.cost), name: a.name ?? "", damage: String(a.damage ?? ""), text: a.effect ?? "" })),
      weakness: TCGDEX_TYPE[c.weaknesses?.[0]?.type] ?? "none",
      weaknessAmount: c.weaknesses?.[0]?.value ?? "×2",
      resistance: TCGDEX_TYPE[c.resistances?.[0]?.type] ?? "none",
      resistanceAmount: c.resistances?.[0]?.value ?? "",
      retreat: Number(c.retreat ?? 0),
    },
  };
}

const REAL_MASKS: RealMask[] = [
  { id: "name", label: "Nome", x: 0.18, y: 0.03, w: 0.5, h: 0.055, fill: "auto" },
  { id: "moves", label: "Ataques", x: 0.05, y: 0.53, w: 0.9, h: 0.3, fill: "auto" },
];

export const pokemon: TcgProfile = {
  id: "pokemon",
  proxyMark: { position: "bottom", opacity: 0.9, size: 1.6, inset: 0.45 },
  name: "Pokémon TCG",
  packId: "pokemon",
  size: { width: 63, height: 88 },
  cardTypes: CARD_TYPES,
  symbols: TYPES.map((t) => ({ code: `{${t}}`, label: PT_NAMES[t] ?? t })),
  build(state, geo) {
    if (state.cardType === "trainer") return buildTrainer(state, geo);
    if (state.cardType === "energy") return buildEnergy(state, geo);
    return buildPokemon({ ...state, fields: { ...state.fields, _type: state.cardType } }, geo);
  },
  fromApi: fromTcgdex,
  realMasks: () => REAL_MASKS.map((m) => ({ ...m })),
};
