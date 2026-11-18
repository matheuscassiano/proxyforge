import type { BaseLayer, CardDesign, Fill, ImageLayer, Layer, ShapeLayer, TextLayer } from "./types";
import { NEUTRAL_FILTERS } from "./render";

const uid = () => crypto.randomUUID();

const base = (name: string, x: number, y: number, w: number, h: number): BaseLayer => ({
  id: uid(),
  name,
  x,
  y,
  w,
  h,
  rotation: 0,
  opacity: 1,
  visible: true,
  locked: false,
  blend: "source-over",
  shadow: null,
});

export function rect(name: string, x: number, y: number, w: number, h: number, fill: Fill, extra: Partial<ShapeLayer> = {}): ShapeLayer {
  return { ...base(name, x, y, w, h), kind: "rect", fill, stroke: null, radius: 0, sides: 6, star: false, ...extra };
}

export function ellipse(name: string, x: number, y: number, w: number, h: number, fill: Fill, extra: Partial<ShapeLayer> = {}): ShapeLayer {
  return { ...rect(name, x, y, w, h, fill, extra), kind: "ellipse", ...extra };
}

export function polygon(name: string, x: number, y: number, w: number, h: number, fill: Fill, extra: Partial<ShapeLayer> = {}): ShapeLayer {
  return { ...rect(name, x, y, w, h, fill), kind: "polygon", sides: 5, star: true, ...extra };
}

export function text(name: string, x: number, y: number, w: number, h: number, content: string, extra: Partial<TextLayer> = {}): TextLayer {
  return {
    ...base(name, x, y, w, h),
    kind: "text",
    text: content,
    font: "EB Garamond",
    size: 8,
    weight: 400,
    italic: false,
    color: "#111111",
    align: "left",
    vAlign: "top",
    lineHeight: 1.18,
    letterSpacing: 0,
    uppercase: false,
    autoFit: false,
    stroke: null,
    background: { kind: "none" },
    padding: 0,
    radius: 0,
    ...extra,
  };
}

export function image(name: string, x: number, y: number, w: number, h: number, extra: Partial<ImageLayer> = {}): ImageLayer {
  return {
    ...base(name, x, y, w, h),
    kind: "image",
    imageId: null,
    fit: "cover",
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    flipX: false,
    radius: 0,
    stroke: null,
    filters: { ...NEUTRAL_FILTERS },
    ...extra,
  };
}

const solid = (color: string): Fill => ({ kind: "solid", color });
const linear = (angle: number, ...colors: string[]): Fill => ({
  kind: "linear",
  angle,
  stops: colors.map((c, i) => ({ offset: i / Math.max(1, colors.length - 1), color: c })),
});
const radial = (...colors: string[]): Fill => ({
  kind: "radial",
  stops: colors.map((c, i) => ({ offset: i / Math.max(1, colors.length - 1), color: c })),
});

export const FRAME_COLORS: Record<string, { name: string; frame: [string, string]; bar: string; box: string; cost: string }> = {
  red: { name: "Vermelho", frame: ["#c2410c", "#7f1d1d"], bar: "#f5e1cc", box: "#f8ece0", cost: "{2}{R}{R}" },
  blue: { name: "Azul", frame: ["#2563eb", "#1e3a8a"], bar: "#dbe7f5", box: "#eaf1f9", cost: "{1}{U}{U}" },
  green: { name: "Verde", frame: ["#15803d", "#14532d"], bar: "#dcebd5", box: "#eef5ea", cost: "{2}{G}" },
  black: { name: "Preto", frame: ["#3f3f46", "#09090b"], bar: "#d9d4cf", box: "#ebe7e3", cost: "{1}{B}{B}" },
  white: { name: "Branco", frame: ["#e7e2cf", "#b8ae8c"], bar: "#f8f5e8", box: "#fbf9f0", cost: "{1}{W}" },
  gold: { name: "Dourado", frame: ["#d4a017", "#8a6512"], bar: "#f7ecc8", box: "#fbf4dd", cost: "{W}{U}{B}{R}{G}" },
  artifact: { name: "Artefato", frame: ["#9ca3af", "#4b5563"], bar: "#e5e7eb", box: "#f3f4f6", cost: "{3}" },
};

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  preview: string; // css gradient for the picker
}

export const TEMPLATES: TemplateInfo[] = [
  { id: "classic", name: "Clássica", description: "Moldura, barras de nome e tipo, caixa de regras, força/resistência", preview: "linear-gradient(160deg,#c2410c,#7f1d1d)" },
  { id: "fullart", name: "Arte total", description: "Arte sangrando na carta inteira com texto sobre degradê", preview: "linear-gradient(160deg,#0ea5e9,#1e293b)" },
  { id: "token", name: "Ficha", description: "Arte grande, nome central, texto curto", preview: "linear-gradient(160deg,#065f46,#a3e635)" },
  { id: "modern", name: "Moderna", description: "Fundo claro, arte com cantos arredondados, tipografia sem serifa", preview: "linear-gradient(160deg,#f4f4f5,#a1a1aa)" },
  { id: "back", name: "Verso", description: "Verso simétrico com emblema", preview: "radial-gradient(#b45309,#1c1917)" },
  { id: "blank", name: "Em branco", description: "Só o fundo — monte do zero", preview: "linear-gradient(#ffffff,#e4e4e7)" },
];

export function createDesign(templateId: string, width: number, height: number, bleed = 3, color = "red"): CardDesign {
  const b = bleed;
  const W = width + 2 * b;
  const H = height + 2 * b;
  const sx = width / 63; // scale template geometry from a 63×88 card
  const sy = height / 88;
  const X = (v: number) => b + v * sx;
  const Y = (v: number) => b + v * sy;
  const theme = FRAME_COLORS[color] ?? FRAME_COLORS.red;
  let layers: Layer[] = [];
  let name = "Nova carta";

  switch (templateId) {
    case "classic":
      name = "Carta clássica";
      layers = [
        rect("Fundo", 0, 0, W, H, solid("#161311")),
        rect("Moldura", X(2.2), Y(2.2), 58.6 * sx, 83.6 * sy, linear(170, ...theme.frame), { radius: 2.2, stroke: { color: "#0a0a0a", width: 0.25 } }),
        rect("Barra do nome", X(4), Y(4.2), 55 * sx, 6.4 * sy, solid(theme.bar), { radius: 1.2, stroke: { color: "#1c1917", width: 0.3 } }),
        text("Nome", X(5.3), Y(4.5), 36 * sx, 5.8 * sy, "Dragão de Fogo", { font: "Cinzel", size: 8.6, weight: 700, vAlign: "middle", autoFit: true }),
        text("Custo", X(40), Y(4.5), 18.2 * sx, 5.8 * sy, theme.cost, { size: 8, align: "right", vAlign: "middle" }),
        image("Arte", X(5), Y(11.4), 53 * sx, 38.6 * sy, { stroke: { color: "#1c1917", width: 0.35 } }),
        rect("Barra do tipo", X(4), Y(50.6), 55 * sx, 5.8 * sy, solid(theme.bar), { radius: 1.2, stroke: { color: "#1c1917", width: 0.3 } }),
        text("Tipo", X(5.3), Y(50.8), 44 * sx, 5.4 * sy, "Criatura — Dragão", { font: "Cinzel", size: 7, weight: 700, vAlign: "middle", autoFit: true }),
        ellipse("Símbolo da coleção", X(53.2), Y(51.7), 3.6 * sx, 3.6 * sy, radial("#fde68a", "#b45309"), { stroke: { color: "#1c1917", width: 0.25 } }),
        rect("Caixa de texto", X(5), Y(57.2), 53 * sx, 23.5 * sy, solid(theme.box), { stroke: { color: "#1c1917", width: 0.3 } }),
        text(
          "Texto de regras",
          X(6.4),
          Y(58.4),
          50.2 * sx,
          21 * sy,
          "**Voar**\nQuando Dragão de Fogo entrar, ele causa 3 pontos de dano a qualquer alvo.\n{T}: Adicione {R}.\n*O céu queimou por três dias e três noites.*",
          { size: 8.2, autoFit: true, lineHeight: 1.15 },
        ),
        rect("Caixa F/R", X(46.5), Y(78.5), 12.5 * sx, 5.6 * sy, solid(theme.bar), { radius: 1.2, stroke: { color: "#1c1917", width: 0.3 } }),
        text("Força/Resistência", X(46.5), Y(78.5), 12.5 * sx, 5.6 * sy, "4/4", { font: "Cinzel", size: 8.5, weight: 700, align: "center", vAlign: "middle" }),
        text("Rodapé", X(5), Y(81.6), 40 * sx, 3.4 * sy, "Ilustração: — · Proxy, não é para venda", { font: "Montserrat", size: 4.2, color: "#f5f5f4", vAlign: "middle" }),
      ];
      break;
    case "fullart":
      name = "Arte total";
      layers = [
        image("Arte", 0, 0, W, H),
        rect("Degradê", 0, H * 0.45, W, H * 0.55, linear(180, "#00000000", "#000000e6")),
        text("Nome", X(4), Y(4), 55 * sx, 7 * sy, "Guardiã do Abismo", { font: "Cinzel", size: 11, weight: 700, color: "#ffffff", shadow: { color: "#000000cc", blur: 1, x: 0, y: 0.3 }, autoFit: true }),
        text("Tipo", X(4), Y(60), 55 * sx, 5 * sy, "Criatura — Espírito", { font: "Cinzel", size: 7, weight: 700, color: "#e7e5e4" }),
        text("Texto de regras", X(4), Y(66), 55 * sx, 17 * sy, "Quando esta carta entrar, compre uma carta.\n*Ela guarda o que o mar esqueceu.*", { size: 8.4, color: "#fafaf9", autoFit: true, shadow: { color: "#000000", blur: 0.8, x: 0, y: 0.2 } }),
        text("Força/Resistência", X(49), Y(82), 10 * sx, 4.5 * sy, "3/5", { font: "Cinzel", size: 9, weight: 700, color: "#ffffff", align: "right" }),
      ];
      break;
    case "token":
      name = "Ficha";
      layers = [
        rect("Fundo", 0, 0, W, H, linear(180, "#1f2937", "#030712")),
        image("Arte", X(4), Y(4), 55 * sx, 58 * sy, { radius: 3, stroke: { color: "#d4d4d8", width: 0.4 } }),
        text("Nome", X(4), Y(63), 55 * sx, 8 * sy, "FICHA", { font: "Cinzel", size: 12, weight: 700, color: "#fafafa", align: "center", vAlign: "middle", letterSpacing: 0.12 }),
        text("Tipo", X(4), Y(71), 55 * sx, 4.5 * sy, "Criatura — Soldado", { font: "Cinzel", size: 7, color: "#d4d4d8", align: "center" }),
        text("Texto de regras", X(8), Y(76), 47 * sx, 8 * sy, "Vigilância", { size: 8.5, color: "#e5e5e5", align: "center", vAlign: "middle", autoFit: true }),
      ];
      break;
    case "modern":
      name = "Carta moderna";
      layers = [
        rect("Fundo", 0, 0, W, H, solid("#f4f4f5")),
        image("Arte", X(4), Y(4), 55 * sx, 46 * sy, { radius: 3 }),
        text("Nome", X(4.5), Y(52.5), 54 * sx, 7 * sy, "Engenheira Solar", { font: "Montserrat", size: 11, weight: 700, color: "#18181b", autoFit: true }),
        text("Tipo", X(4.5), Y(59.5), 54 * sx, 4.5 * sy, "Unidade · Tecnologia", { font: "Montserrat", size: 6.5, color: "#71717a", uppercase: true, letterSpacing: 0.08 }),
        rect("Separador", X(4.5), Y(65), 54 * sx, 0.3, solid("#d4d4d8")),
        text("Texto de regras", X(4.5), Y(67), 54 * sx, 16 * sy, "Ao entrar em jogo, ganhe 2 de energia.\n**Recarregar 2** — ao fim do turno, compre uma carta.", { font: "Inter Variable", size: 7.6, color: "#27272a", autoFit: true, lineHeight: 1.3 }),
        ellipse("Custo", X(51), Y(6), 7 * sx, 7 * sx, solid("#f28c28"), { stroke: { color: "#ffffff", width: 0.5 } }),
        text("Valor do custo", X(51), Y(6), 7 * sx, 7 * sx, "3", { font: "Montserrat", size: 11, weight: 700, color: "#ffffff", align: "center", vAlign: "middle" }),
      ];
      break;
    case "back":
      name = "Verso";
      layers = [
        rect("Fundo", 0, 0, W, H, radial("#b45309", "#451a03", "#0c0a09")),
        rect("Borda", X(3), Y(3), 57 * sx, 82 * sy, { kind: "none" }, { radius: 3, stroke: { color: "#fbbf24", width: 0.6 } }),
        rect("Borda interna", X(5), Y(5), 53 * sx, 78 * sy, { kind: "none" }, { radius: 2, stroke: { color: "#fbbf2499", width: 0.3, dash: 1 } }),
        ellipse("Anel", X(13), Y(26), 37 * sx, 37 * sx, { kind: "none" }, { stroke: { color: "#fbbf24", width: 0.8 } }),
        polygon("Emblema", X(19), Y(32), 25 * sx, 25 * sx, radial("#fde68a", "#d97706"), { sides: 8, star: true, stroke: { color: "#78350f", width: 0.3 } }),
        text("Título", X(4), Y(70), 55 * sx, 8 * sy, "PROXY", { font: "Cinzel", size: 14, weight: 700, color: "#fde68a", align: "center", vAlign: "middle", letterSpacing: 0.3 }),
      ];
      break;
    default:
      name = "Em branco";
      layers = [rect("Fundo", 0, 0, W, H, solid("#ffffff"))];
  }
  return { id: uid(), name, width, height, bleed: b, safe: 3, layers, backId: null, updatedAt: new Date().toISOString() };
}

export function newLayer(kind: "text" | "image" | "rect" | "ellipse" | "polygon", d: CardDesign): Layer {
  const cx = d.bleed + d.width / 2;
  const cy = d.bleed + d.height / 2;
  switch (kind) {
    case "text":
      return text("Texto", cx - 20, cy - 5, 40, 10, "Texto", { align: "center", vAlign: "middle", size: 10 });
    case "image":
      return image("Imagem", cx - 20, cy - 15, 40, 30);
    case "ellipse":
      return ellipse("Elipse", cx - 10, cy - 10, 20, 20, solid("#f28c28"));
    case "polygon":
      return polygon("Estrela", cx - 10, cy - 10, 20, 20, solid("#facc15"));
    default:
      return rect("Retângulo", cx - 15, cy - 10, 30, 20, solid("#f28c28"), { radius: 1 });
  }
}

export function cloneLayer(l: Layer): Layer {
  return { ...structuredClone(l), id: uid(), name: `${l.name} (cópia)`, x: l.x + 2, y: l.y + 2 };
}
