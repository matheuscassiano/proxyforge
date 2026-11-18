// Browser-only preview mode for UI work: `pnpm dev` then open http://localhost:1420/?mock
// Fakes the Tauri commands with sample data. Never loaded inside the desktop app.
import { mockIPC } from "@tauri-apps/api/mocks";

const art = (seed: number) => `https://picsum.photos/seed/pf${seed}/372/520`;
const layout = {
  pagePreset: "letter",
  pageSize: { width: 215.9, height: 279.4 },
  orientation: "portrait",
  margins: { top: 4, right: 4, bottom: 4, left: 4 },
  spacingXMm: 0,
  spacingYMm: 0,
  cardPreset: "standard",
  cardSize: { width: 63, height: 88 },
  cornerRadiusMm: 3,
  bleedMm: 1,
  bleedMode: "extend",
  columns: 0,
  rows: 0,
  center: true,
  cutGuides: { style: "crop", color: "#000000", widthPt: 0.5, lengthMm: 4 },
  duplex: { enabled: false, flip: "longEdge", offsetXMm: 0, offsetYMm: 0, defaultBack: null },
  registrationMarks: false,
  guidesOverArt: false,
};
const names = ["Lightning Bolt", "Counterspell", "Delver of Secrets", "Brainstorm", "Ponder", "Young Pyromancer"];
const project = {
  id: "demo",
  name: "Izzet Spellslinger",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  cards: names.map((n, i) => ({ id: `c${i}`, name: n, qty: [4, 3, 4, 4, 4, 3][i], front: `img${i}`, back: i === 2 ? "img9" : null, source: { game: "mtg", cardId: `x${i}`, setCode: "2X2", number: String(100 + i) }, isToken: false })),
  layout,
  printProfileId: "default",
};
const adjustments = { brightness: 0, contrast: 0, saturation: 0, vibrance: 0, gamma: 1, levelsBlack: 0, levelsWhite: 1, red: 1, green: 1, blue: 1, curveMaster: [], curveRed: [], curveGreen: [], curveBlue: [], sharpen: 0 };

function previewPng(p: typeof project, dpi: number): string {
  const k = dpi / 25.4;
  const c = document.createElement("canvas");
  c.width = Math.round(p.layout.pageSize.width * k);
  c.height = Math.round(p.layout.pageSize.height * k);
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  const cw = (p.layout.cardSize.width + 2 * p.layout.bleedMm) * k;
  const ch = (p.layout.cardSize.height + 2 * p.layout.bleedMm) * k;
  const ox = (c.width - 3 * cw) / 2;
  const oy = (c.height - 3 * ch) / 2;
  const colors = ["#7c3aed", "#0ea5e9", "#dc2626", "#065f46", "#1d4ed8", "#78350f"];
  for (let i = 0; i < 9; i++) {
    g.fillStyle = colors[i % colors.length];
    g.fillRect(ox + (i % 3) * cw, oy + Math.floor(i / 3) * ch, cw, ch);
  }
  return c.toDataURL("image/png").split(",")[1];
}

export function installMock() {
  mockIPC(
    (cmd, args: any) => {
      switch (cmd) {
        case "app_info":
          return {
            version: "0.1.0-mock",
            dataDir: "/Users/demo/Library/Application Support/com.proxyforge.app",
            upscalerAvailable: true,
            games: ["mtg", "pokemon", "yugioh", "fab", "lorcana", "onepiece", "swu", "digimon", "riftbound"].map((g) => ({ game: g, name: g, source: "mock", beta: g === "riftbound" })),
            models: [
              { id: "realesrgan-x4plus", name: "Real-ESRGAN x4plus", description: "Best for painted and photographic card art", nativeScales: [4] },
              { id: "realesrgan-x4plus-anime", name: "Real-ESRGAN x4plus Anime", description: "Flat colours, line art and anime styles", nativeScales: [4] },
              { id: "realesr-animevideov3", name: "AnimeVideo v3", description: "Fast, small model; native x2 / x3 / x4", nativeScales: [2, 3, 4] },
            ],
            cardPresets: [{ id: "standard", name: "Standard", width: 63, height: 88 }, { id: "japanese", name: "Japanese / Yu-Gi-Oh!", width: 59, height: 86 }],
            pagePresets: [{ id: "letter", name: "Letter", width: 215.9, height: 279.4 }, { id: "a4", name: "A4", width: 210, height: 297 }],
          };
        case "print_profiles":
          return [
            { id: "default", name: "Home inkjet (sRGB)", outputIcc: "builtin:srgb", outputSpace: "rgb", intent: "perceptual", blackPointCompensation: true, embedProfile: true, dpi: 600, adjustments, inkLimit: 400, notes: "" },
            { id: "shop", name: "Print shop", outputIcc: "builtin:naive-cmyk", outputSpace: "cmyk", intent: "perceptual", blackPointCompensation: true, embedProfile: true, dpi: 1200, adjustments, inkLimit: 300, notes: "" },
          ];
        case "list_icc":
          return [
            { id: "builtin:srgb", name: "sRGB IEC61966-2.1", space: "rgb", builtin: true },
            { id: "builtin:naive-cmyk", name: "Generic CMYK (uncalibrated)", space: "cmyk", builtin: true },
          ];
        case "list_presets":
          return [];
        case "list_projects":
          return [{ id: "demo", name: project.name, updatedAt: project.updatedAt, cardCount: 22, thumb: "img0" }];
        case "load_project":
        case "new_project":
          return project;
        case "save_project":
          return args.project;
        case "image_paths":
          return Object.fromEntries(
            (args.ids as string[]).map((id) => {
              const n = Number(id.replace("img", "")) || 0;
              return [id, { full: art(n), thumb: art(n), meta: { id, file: "", width: 745, height: 1040, decodable: true, note: "" } }];
            }),
          );
        case "grid_info":
          return { columns: 3, rows: 3, perPage: 9, pages: Math.ceil(args.cardCount / 9), page: { width: 215.9, height: 279.4 } };
        case "render_preview": {
          const png = Uint8Array.from(atob(previewPng(args.project, args.dpi)), (c) => c.charCodeAt(0));
          const out = new Uint8Array(png.length + 4);
          new DataView(out.buffer).setUint32(0, 3, true);
          out.set(png, 4);
          return out.buffer;
        }
        case "read_image": {
          const c = document.createElement("canvas");
          c.width = 600;
          c.height = 450;
          const g = c.getContext("2d")!;
          const gr = g.createRadialGradient(300, 200, 10, 300, 225, 380);
          gr.addColorStop(0, "#fde68a");
          gr.addColorStop(0.45, "#ea580c");
          gr.addColorStop(1, "#1c0a03");
          g.fillStyle = gr;
          g.fillRect(0, 0, 600, 450);
          const bin = atob(c.toDataURL("image/png").split(",")[1]);
          return Uint8Array.from(bin, (ch) => ch.charCodeAt(0)).buffer;
        }
        case "list_fonts":
          return [];
        case "import_image_data":
          return { id: "built" + Math.random().toString(36).slice(2, 7), file: "", width: 1630, height: 2220, decodable: true, note: "" };
        case "search_cards":
          return {
            results: Array.from({ length: 9 }, (_, i) => ({ game: args.game, id: `r${i}`, name: `${args.query} ${i + 1}`, setCode: "M11", setName: "Magic 2011", number: String(140 + i), imageUrl: art(20 + i), thumbUrl: art(20 + i), backImageUrl: null, isToken: false, lang: "en" })),
            total: 72,
            hasMore: true,
            source: "Scryfall",
          };
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}
