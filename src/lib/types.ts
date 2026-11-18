// Mirrors src-tauri/src/model.rs (serde camelCase).

export type Game =
  | "mtg"
  | "pokemon"
  | "yugioh"
  | "fab"
  | "lorcana"
  | "onepiece"
  | "swu"
  | "digimon"
  | "riftbound"
  | "custom";

export interface CardSource {
  game: Game;
  cardId: string;
  setCode: string;
  number: string;
}

export interface CardEntry {
  id: string;
  name: string;
  qty: number;
  front: string;
  back?: string | null;
  originalFront?: string | null;
  originalBack?: string | null;
  source?: CardSource | null;
  builtinBleedMm?: number | null;
  isToken: boolean;
  /** Card made in the builder (id in Project.designs). */
  designId?: string | null;
  /** Sortable game data (Magic). */
  meta?: CardMeta | null;
}

export interface CardMeta {
  manaValue?: number | null;
  /** WUBRG letters; empty = colourless. */
  colors: string;
  typeLine: string;
  rarity: string;
}

export interface ImportOpts {
  /** Language for lines without their own `lang:`. */
  lang?: string | null;
  /** Also add the tokens and emblems the cards make (Magic). */
  tokens?: boolean;
}

export interface SizeMm {
  width: number;
  height: number;
}

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type Orientation = "portrait" | "landscape";
export type BleedMode = "extend" | "mirror" | "solid" | "stretch" | "blur";
/** Legacy single guide style (old projects); new ones use pageStyle / cardStyle. */
export type CutGuideStyle = "none" | "crop" | "lines" | "corners";
export type PageGuideStyle = "none" | "crop" | "full";
export type CardGuideStyle = "none" | "corners" | "outline";
export type GuidePlacement = "inside" | "outside" | "centered";
export type GuideCorner = "square" | "round";
export type BuiltinBleed = "use" | "regenerate";
export type DarkenMode = "contrastEdges" | "darkenAll";

export interface CutGuides {
  style: CutGuideStyle;
  color: string;
  widthPt: number;
  lengthMm: number;
  pageStyle?: PageGuideStyle | null;
  cardStyle?: CardGuideStyle | null;
  placement: GuidePlacement;
  corner: GuideCorner;
  dashed: boolean;
  /** Gap between the art and marks drawn outside it. */
  offsetMm: number;
  faces: { cardFront: boolean; pageFront: boolean; cardBack: boolean; pageBack: boolean };
}

export interface RegistrationMarks {
  insetMm: number;
  lengthMm: number;
  thicknessMm: number;
  squareMm: number;
}

export interface EdgeDarken {
  enabled: boolean;
  mode: DarkenMode;
  amount: number;
  edgeWidthMm: number;
  threshold: number;
  bank: boolean;
  uploads: boolean;
  backs: boolean;
}
export type DuplexFlip = "longEdge" | "shortEdge";

export interface LayoutSettings {
  pagePreset: string;
  pageSize: SizeMm;
  orientation: Orientation;
  margins: Margins;
  spacingXMm: number;
  spacingYMm: number;
  cardPreset: string;
  cardSize: SizeMm;
  cornerRadiusMm: number;
  bleedMm: number;
  bleedMode: BleedMode;
  builtinBleed: BuiltinBleed;
  edgeDarken: EdgeDarken;
  columns: number;
  rows: number;
  center: boolean;
  cutGuides: CutGuides;
  duplex: { enabled: boolean; flip: DuplexFlip; offsetXMm: number; offsetYMm: number; defaultBack?: string | null };
  registrationMarks: boolean;
  registration: RegistrationMarks;
  guidesOverArt: boolean;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cards: CardEntry[];
  layout: LayoutSettings;
  printProfileId?: string | null;
  /** Card builder designs (see src/builder/types.ts). */
  designs?: unknown[];
  /** Non-destructive upscaling used by previews, exports and prints. */
  upscale: AutoUpscale;
}

export interface AutoUpscale {
  auto: boolean;
  model: string;
  /** Largest factor used to reach the print DPI. */
  maxScale: number;
}

export interface PendingUpscale {
  imageId: string;
  scale: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  cardCount: number;
  thumb?: string | null;
}

export type RenderingIntent = "perceptual" | "relativeColorimetric" | "saturation" | "absoluteColorimetric";
export type OutputColorSpace = "rgb" | "cmyk";
export type CurvePoints = [number, number][];

export interface Adjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  vibrance: number;
  gamma: number;
  levelsBlack: number;
  levelsWhite: number;
  red: number;
  green: number;
  blue: number;
  curveMaster: CurvePoints;
  curveRed: CurvePoints;
  curveGreen: CurvePoints;
  curveBlue: CurvePoints;
  sharpen: number;
}

export interface PrintProfile {
  id: string;
  name: string;
  outputIcc: string;
  outputSpace: OutputColorSpace;
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  embedProfile: boolean;
  dpi: number;
  adjustments: Adjustments;
  inkLimit: number;
  notes: string;
}

export interface IccInfo {
  id: string;
  name: string;
  space: OutputColorSpace;
  builtin: boolean;
}

export interface LayoutPreset {
  id: string;
  name: string;
  layout: LayoutSettings;
}

export interface ImageMeta {
  id: string;
  file: string;
  width: number;
  height: number;
  sourceUrl?: string | null;
  decodable: boolean;
  derivedFrom?: string | null;
  note: string;
}

export interface ImagePaths {
  full: string;
  thumb: string;
  meta: ImageMeta;
}

export type ExportFormat = "pdf" | "png" | "tiff" | "zip";

export interface ExportOptions {
  format: ExportFormat;
  path: string;
  dpi?: number | null;
  compression: "lossless" | "jpeg";
  jpegQuality: number;
  sixteenBit: boolean;
  cutFile: boolean;
}

export interface CardResult {
  game: Game;
  id: string;
  name: string;
  setCode: string;
  setName: string;
  number: string;
  imageUrl: string;
  thumbUrl: string;
  backImageUrl?: string | null;
  isToken: boolean;
  lang: string;
  meta?: CardMeta | null;
}

export interface SearchOpts {
  /** ISO code (`en`, `pt`…), `any` for every language, null for the default. */
  lang?: string | null;
  /** The query is a full card name: only printings of exactly that card. */
  exact?: boolean;
}

export interface SearchPage {
  results: CardResult[];
  total?: number | null;
  hasMore: boolean;
  source: string;
}

export interface GameInfo {
  game: Game;
  name: string;
  source: string;
  beta: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  nativeScales: number[];
}

export interface Preset {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  upscalerAvailable: boolean;
  games: GameInfo[];
  models: ModelInfo[];
  cardPresets: Preset[];
  pagePresets: Preset[];
}

export interface GridInfo {
  columns: number;
  rows: number;
  perPage: number;
  pages: number;
  page: SizeMm;
}

export interface ImportReport {
  entries: CardEntry[];
  missing: string[];
}

export interface ProgressEvent {
  task: string;
  progress: number;
  message: string;
}

export interface UpscaleRequest {
  imageId: string;
  model: string;
  scale: number;
  tile: number;
  gpu?: number | null;
  tta: boolean;
}

export interface RectMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SlotMap {
  cardId: string;
  /** Index of this copy in the flattened deck. */
  instance: number;
  rect: RectMm;
}

export interface PageMap {
  side: "front" | "back";
  slots: SlotMap[];
}

export interface PrinterInfo {
  name: string;
  isDefault: boolean;
}

export type PrintSides = "oneSided" | "longEdge" | "shortEdge";

export interface PrintOptions {
  printer: string;
  copies: number;
  dpi?: number | null;
  pages?: string | null;
  sides: PrintSides;
}

/** Page and card guide styles, mapping the legacy single style (mirrors CutGuides::styles in Rust). */
export function guideStyles(g: CutGuides): [PageGuideStyle, CardGuideStyle] {
  if (g.pageStyle != null || g.cardStyle != null) return [g.pageStyle ?? "none", g.cardStyle ?? "none"];
  switch (g.style) {
    case "crop":
      return ["crop", "none"];
    case "lines":
      return ["full", "none"];
    case "corners":
      return ["none", "corners"];
    default:
      return ["none", "none"];
  }
}
