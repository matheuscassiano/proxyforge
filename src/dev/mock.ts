// Browser-only preview mode for UI work: `pnpm dev` then open http://localhost:1420/?mock
// Fakes the Tauri commands with sample data. Never loaded inside the desktop app.
import { mockIPC } from "@tauri-apps/api/mocks";
import mtgPack from "../../packs/manifests/mtg.json";
import pokemonPack from "../../packs/manifests/pokemon.json";
import fabPack from "../../packs/manifests/fab.json";
import { createTcgDesign, PROFILES } from "../builder/tcg/registry";

type Manifest = { id: string; baseUrl: string; files: { path: string; url?: string; size: number }[]; fonts: unknown[] };
const MANIFESTS = [mtgPack, pokemonPack, fabPack] as unknown as Manifest[];
const fetched = new Set<string>();
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const packStatus = (m: Manifest) => ({
  ...m,
  dir: `/mock/packs/${m.id}`,
  installedFiles: m.files.filter((f) => fetched.has(`${m.id}/${f.path}`)).length,
  totalFiles: m.files.length,
  totalBytes: m.files.reduce((s, f) => s + f.size, 0),
  complete: m.files.every((f) => fetched.has(`${m.id}/${f.path}`)),
});
/** Mock mode reads pack files straight from their public URLs (both hosts allow CORS). */
async function fetchBytes(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}
const SAMPLE_DETAILS: Record<string, unknown> = {
  mtg: {
    name: "Lightning Bolt", mana_cost: "{R}", type_line: "Instant", oracle_text: "Lightning Bolt deals 3 damage to any target.", flavor_text: "The sparkmage shrieked, calling on the rage of the storms of his youth.",
    artist: "Christopher Moeller", set: "2x2", rarity: "uncommon", collector_number: "117", lang: "en", layout: "normal",
    image_uris: { art_crop: "https://cards.scryfall.io/art_crop/front/f/2/f29ba16f-c8fb-42fe-aabf-87089cb214a7.jpg", png: "https://cards.scryfall.io/png/front/f/2/f29ba16f-c8fb-42fe-aabf-87089cb214a7.png" },
  },
  pokemon: {
    name: "Charizard V", category: "Pokemon", hp: 220, types: ["Fire"], stage: "Basic", suffix: "V", illustrator: "Ryota Murayama", localId: "19", rarity: "Holo Rare V", regulationMark: "D",
    set: { id: "swsh3", cardCount: { official: 189 } }, attacks: [{ cost: ["Fire", "Colorless"], name: "Claw Slash", damage: 60 }, { cost: ["Fire", "Fire", "Colorless", "Colorless"], name: "Fire Spin", damage: 220, effect: "Discard 2 Energy from this Pokémon." }],
    weaknesses: [{ type: "Water", value: "×2" }], retreat: 3, image: "https://assets.tcgdex.net/en/swsh/swsh3/19",
  },
  fab: {
    name: "Snatch", pitch: "1", cost: "0", power: "4", defense: "2", types: ["Generic", "Action", "Attack"], type_text: "Generic Action – Attack", functional_text_plain: "If Snatch hits, draw a card.",
    printing: { id: "WTR167", rarity: "C", artists: ["Carlos Cruchaga"], image_url: "" },
  },
};

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
  builtinBleed: "use",
  edgeDarken: { enabled: false, mode: "contrastEdges", amount: 0.6, edgeWidthMm: 3, threshold: 0.3, bank: true, uploads: false, backs: false },
  columns: 0,
  rows: 0,
  center: true,
  cutGuides: {
    style: "crop", color: "#000000", widthPt: 0.5, lengthMm: 4, pageStyle: "crop", cardStyle: "none", placement: "inside", corner: "square",
    dashed: false, offsetMm: 1, faces: { cardFront: true, pageFront: true, cardBack: false, pageBack: false },
  },
  duplex: { enabled: false, flip: "longEdge", offsetXMm: 0, offsetYMm: 0, defaultBack: null },
  registrationMarks: false,
  registration: { insetMm: 10, lengthMm: 20, thicknessMm: 1, squareMm: 5 },
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
  upscale: { auto: false, model: "realesrgan-x4plus", maxScale: 4 },
  printProfileId: "default",
  // ?mock&builder preloads one design per TCG card type (card builder visual checks)
  designs: new URLSearchParams(location.search).has("builder")
    ? (["mtg", "pokemon", "fab"] as const).flatMap((g) => PROFILES[g].cardTypes.map((t) => createTcgDesign(g, t.id)))
    : [],
};
const adjustments = { brightness: 0, contrast: 0, saturation: 0, vibrance: 0, gamma: 1, levelsBlack: 0, levelsWhite: 1, red: 1, green: 1, blue: 1, curveMaster: [], curveRed: [], curveGreen: [], curveBlue: [], sharpen: 0 };

type MockProject = typeof project & { cards: { id: string; name: string; qty: number; back?: string | null }[] };

/** Same pagination as render::page_map for a 3×3 Letter grid. */
function mockMap(p: MockProject) {
  const l = p.layout;
  const aw = l.cardSize.width + 2 * l.bleedMm;
  const ah = l.cardSize.height + 2 * l.bleedMm;
  const ox = (l.pageSize.width - 3 * aw) / 2;
  const oy = (l.pageSize.height - 3 * ah) / 2;
  const inst = p.cards.flatMap((c, i) => Array.from({ length: c.qty }, () => i));
  const rect = (slot: number, back: boolean) => {
    const col = back ? 2 - (slot % 3) : slot % 3;
    return { x: ox + col * aw + l.bleedMm, y: oy + Math.floor(slot / 3) * ah + l.bleedMm, w: l.cardSize.width, h: l.cardSize.height };
  };
  const pages: { side: "front" | "back"; slots: { cardId: string; instance: number; rect: ReturnType<typeof rect> }[] }[] = [];
  for (let s = 0; s * 9 < inst.length; s++) {
    const chunk = inst.slice(s * 9, s * 9 + 9);
    pages.push({ side: "front", slots: chunk.map((ci, i) => ({ cardId: p.cards[ci].id, instance: s * 9 + i, rect: rect(i, false) })) });
    if (l.duplex.enabled) {
      const backs = chunk
        .map((ci, i) => ({ ci, i }))
        .filter(({ ci }) => p.cards[ci].back || l.duplex.defaultBack)
        .map(({ ci, i }) => ({ cardId: p.cards[ci].id, instance: s * 9 + i, rect: rect(i, true) }));
      if (backs.length) pages.push({ side: "back", slots: backs });
    }
  }
  return pages;
}

function previewPng(p: MockProject, page: number, dpi: number): string {
  const k = dpi / 25.4;
  const c = document.createElement("canvas");
  c.width = Math.round(p.layout.pageSize.width * k);
  c.height = Math.round(p.layout.pageSize.height * k);
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  const colors = ["#7c3aed", "#0ea5e9", "#dc2626", "#065f46", "#1d4ed8", "#78350f", "#9d174d", "#0f766e"];
  const pg = mockMap(p)[page];
  for (const s of pg?.slots ?? []) {
    const idx = p.cards.findIndex((x) => x.id === s.cardId);
    const b = p.layout.bleedMm;
    g.fillStyle = pg.side === "back" ? "#334155" : colors[idx % colors.length];
    g.fillRect((s.rect.x - b) * k, (s.rect.y - b) * k, (s.rect.w + 2 * b) * k, (s.rect.h + 2 * b) * k);
    g.fillStyle = "#fff";
    g.font = `${Math.max(8, 4 * k)}px sans-serif`;
    g.fillText(`${p.cards[idx]?.name ?? ""} #${s.instance + 1}`, (s.rect.x + 3) * k, (s.rect.y + 8) * k);
  }
  return c.toDataURL("image/png").split(",")[1];
}

export function installMock() {
  mockIPC(
    async (cmd, args: any) => {
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
          const png = Uint8Array.from(atob(previewPng(args.project, args.page, args.dpi)), (c) => c.charCodeAt(0));
          const out = new Uint8Array(png.length + 4);
          new DataView(out.buffer).setUint32(0, mockMap(args.project).length, true);
          out.set(png, 4);
          return out.buffer;
        }
        case "plugin:dialog|ask":
          return window.confirm(args.message);
        case "page_map":
          return mockMap(args.project);
        case "upscale_pending":
          return [];
        case "render_region": {
          // crop of a 300 DPI mock page
          const dpi = 300;
          const k = dpi / 25.4;
          const img = new Image();
          img.src = `data:image/png;base64,${previewPng(args.project, args.page, dpi)}`;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = Math.round(args.rect.w * k);
          c.height = Math.round(args.rect.h * k);
          c.getContext("2d")!.drawImage(img, -args.rect.x * k, -args.rect.y * k);
          return Uint8Array.from(atob(c.toDataURL("image/png").split(",")[1]), (ch) => ch.charCodeAt(0)).buffer;
        }
        case "list_printers":
          return [
            { name: "Epson_ET_8550_Series", isDefault: true },
            { name: "HP_LaserJet_Pro", isDefault: false },
          ];
        case "print_project":
          return new Promise((r) => setTimeout(() => r("request id is Epson_ET_8550_Series-42 (1 file(s))"), 900));
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
        case "list_packs":
          return MANIFESTS.map(packStatus);
        case "install_pack":
          return new Promise((r) => setTimeout(() => {
            const m = MANIFESTS.find((x) => x.id === args.id)!;
            m.files.forEach((f) => fetched.add(`${m.id}/${f.path}`));
            r(packStatus(m));
          }, 1200));
        case "read_pack_file": {
          const m = MANIFESTS.find((x) => x.id === args.pack);
          const f = m?.files.find((x) => x.path === args.path);
          if (!m || !f) throw new Error(`not in pack: ${args.path}`);
          fetched.add(`${m.id}/${f.path}`);
          return fetchBytes(f.url ?? m.baseUrl + encodePath(f.path));
        }
        case "fetch_asset":
          return fetchBytes(args.url);
        case "fetch_card":
          return {
            id: "fc" + Math.random().toString(36).slice(2, 6), name: args.result.name, qty: 1, front: `url:${args.result.imageUrl}`, back: null, isToken: false,
            source: { game: args.result.game, cardId: args.result.id, setCode: args.result.setCode, number: args.result.number },
          };
        case "card_details":
          return SAMPLE_DETAILS[args.game] ?? null;
        case "import_image_data":
          return { id: "built" + Math.random().toString(36).slice(2, 7), file: "", width: 1630, height: 2220, decodable: true, note: "" };
        case "search_cards":
          return {
            results: Array.from({ length: 9 }, (_, i) => {
              const n = args.page * 9 + i;
              const lang = args.opts?.lang && args.opts.lang !== "any" ? args.opts.lang : n % 4 === 3 ? "ja" : "en";
              return { game: args.game, id: `r${n}`, name: args.opts?.exact ? args.query : `${args.query} ${n + 1}`, setCode: ["M11", "2X2", "STA", "CLB"][n % 4], setName: "Magic 2011", number: String(140 + n), imageUrl: art(20 + (n % 30)), thumbUrl: art(20 + (n % 30)), backImageUrl: null, isToken: false, lang };
            }),
            total: 27,
            hasMore: args.page < 2,
            source: "Scryfall",
          };
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}

// ?mock&builder: `await __grid([0,1,2])` renders designs side by side over the UI (click to close).
if (new URLSearchParams(location.search).has("builder")) {
  (window as unknown as Record<string, unknown>).__grid = async (idxs: number[], k = 5) => {
    const R = await import("../builder/render");
    const P = await import("../builder/packs");
    const F = await import("../builder/fonts");
    const reg = await import("../builder/tcg/registry");
    const ds = project.designs;
    const urls: string[] = [];
    for (const i of idxs) {
      const d = ds[i];
      if (d.tcg) await P.loadPackFonts(reg.profileFor(d.tcg.game)!.packId);
      await F.ensureFonts(d.layers.flatMap((t) => (t.kind === "text" ? [t.font, t.fallback].filter((x): x is string => !!x).map((font) => ({ font, weight: t.weight, italic: t.italic })) : [])));
      const c = document.createElement("canvas");
      c.width = Math.round((d.width + 2 * d.bleed) * k);
      c.height = Math.round((d.height + 2 * d.bleed) * k);
      R.renderDesign(c.getContext("2d")!, d, k, await R.loadAssets(d));
      urls.push(c.toDataURL());
    }
    let o = document.getElementById("__ov");
    if (!o) {
      o = document.createElement("div");
      o.id = "__ov";
      o.style.cssText = "position:fixed;inset:0;z-index:9999;background:#222;display:flex;gap:6px;align-items:center;justify-content:center;overflow:hidden";
      document.body.appendChild(o);
      o.onclick = () => o!.remove();
    }
    o.innerHTML = "";
    for (const u of urls) {
      const img = new Image();
      img.src = u;
      img.style.cssText = `max-height:100%;max-width:${Math.floor(100 / idxs.length) - 1}%`;
      o.appendChild(img);
    }
    return ds.map((d, i) => `${i}:${d.name}`).join(", ");
  };
}
