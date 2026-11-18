// Typed wrappers over the Tauri commands in src-tauri/src/lib.rs.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  CardEntry,
  CardResult,
  ExportOptions,
  Game,
  GridInfo,
  IccInfo,
  ImageMeta,
  ImagePaths,
  ImportReport,
  PageMap,
  PrintOptions,
  PrinterInfo,
  LayoutPreset,
  LayoutSettings,
  PrintProfile,
  ProgressEvent,
  Project,
  ProjectSummary,
  SearchPage,
  SizeMm,
  UpscaleRequest,
} from "./types";

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),

  listProjects: () => invoke<ProjectSummary[]>("list_projects"),
  newProject: (name: string) => invoke<Project>("new_project", { name }),
  loadProject: (id: string) => invoke<Project>("load_project", { id }),
  saveProject: (project: Project) => invoke<Project>("save_project", { project }),
  deleteProject: (id: string) => invoke<void>("delete_project", { id }),
  duplicateProject: (id: string) => invoke<Project>("duplicate_project", { id }),
  exportBundle: (id: string, path: string) => invoke<void>("export_bundle", { id, path }),
  importBundle: (path: string) => invoke<Project>("import_bundle", { path }),

  imagePaths: (ids: string[]) => invoke<Record<string, ImagePaths>>("image_paths", { ids }),
  importImages: (paths: string[], card: SizeMm) => invoke<CardEntry[]>("import_images", { paths, card }),
  importImageData: (bytes: Uint8Array, name: string) =>
    invoke<ImageMeta>("import_image_data", bytes, { headers: { "x-name": encodeURIComponent(name) } }),
  convertImage: (id: string, png: Uint8Array) =>
    invoke<ImageMeta>("convert_image", png, { headers: { "x-image-id": id } }),

  searchCards: (game: Game, query: string, page: number, allPrints: boolean) =>
    invoke<SearchPage>("search_cards", { game, query, page, allPrints }),
  fetchCard: (result: CardResult) => invoke<CardEntry>("fetch_card", { result }),
  importDecklist: (game: Game, text: string, format: "text" | "ydk" | "mpc") =>
    invoke<ImportReport>("import_decklist", { game, text, format }),
  importDeckUrl: (url: string) => invoke<ImportReport>("import_deck_url", { url }),
  cancelTask: () => invoke<void>("cancel_task"),

  gridInfo: (layout: LayoutSettings, cardCount: number) => invoke<GridInfo>("grid_info", { layout, cardCount }),
  /** Rendered by the same Rust pipeline as the export. Bytes: u32 LE page count + PNG. */
  renderPreview: async (project: Project, page: number, dpi: number, proof: boolean, gamutWarning: boolean) => {
    const raw = await invoke<ArrayBuffer | number[]>("render_preview", { project, page, dpi, proof, gamutWarning });
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);
    const pageCount = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    return { png: new Blob([bytes.subarray(4)], { type: "image/png" }), pageCount };
  },
  pageMap: (project: Project) => invoke<PageMap[]>("page_map", { project }),
  cardPreview: (imageId: string, layout: LayoutSettings, profileId: string | null, dpi: number, proof: boolean) =>
    invoke<string>("card_preview", { imageId, layout, profileId, dpi, proof }),

  listPresets: () => invoke<LayoutPreset[]>("list_presets"),
  savePresets: (presets: LayoutPreset[]) => invoke<void>("save_presets", { presets }),
  printProfiles: () => invoke<PrintProfile[]>("print_profiles"),
  savePrintProfiles: (profiles: PrintProfile[]) => invoke<void>("save_print_profiles", { profiles }),
  listIcc: () => invoke<IccInfo[]>("list_icc"),
  importIcc: (path: string) => invoke<IccInfo>("import_icc", { path }),
  testChart: (profileId: string, layout: LayoutSettings, path: string) =>
    invoke<void>("test_chart", { profileId, layout, path }),
  duplexCalibration: (layout: LayoutSettings, path: string) => invoke<void>("duplex_calibration", { layout, path }),

  exportProject: (project: Project, options: ExportOptions) =>
    invoke<string[]>("export_project", { project, options }),
  listPrinters: () => invoke<PrinterInfo[]>("list_printers"),
  printProject: (project: Project, options: PrintOptions) => invoke<string>("print_project", { project, options }),
  upscaleImage: (request: UpscaleRequest) => invoke<ImageMeta>("upscale_image", { request }),
};

export function onProgress(cb: (e: ProgressEvent) => void): Promise<UnlistenFn> {
  return listen<ProgressEvent>("progress", (e) => cb(e.payload));
}

export const fileUrl = (path: string) => (/^https?:/.test(path) ? path : convertFileSrc(path));

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
