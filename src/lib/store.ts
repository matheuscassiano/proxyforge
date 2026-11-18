import { create } from "zustand";
import { api, errorText, fileUrl } from "./ipc";
import { detectLang, type Lang } from "./i18n-core";
import type { AppInfo, CardEntry, IccInfo, ImagePaths, LayoutPreset, PrintProfile, Project } from "./types";

export type Panel = "cards" | "layout" | "color" | "upscale";
export type View = "projects" | "workspace";

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
  action?: { label: string; run: () => void };
}

interface AppState {
  info: AppInfo | null;
  lang: Lang;
  view: View;
  panel: Panel;
  project: Project | null;
  saving: boolean;
  savedAt: number | null;
  past: Project[];
  future: Project[];
  images: Record<string, ImagePaths>;
  profiles: PrintProfile[];
  icc: IccInfo[];
  presets: LayoutPreset[];
  toasts: Toast[];
  selectedCard: string | null;
  exportOpen: boolean;
  settingsOpen: boolean;

  init: () => Promise<void>;
  setLang: (l: Lang) => void;
  setView: (v: View) => void;
  setPanel: (p: Panel) => void;
  openProject: (id: string) => Promise<void>;
  createProject: (name: string) => Promise<void>;
  update: (fn: (p: Project) => Project, opts?: { history?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  addCards: (entries: CardEntry[]) => Promise<void>;
  ensureImages: (ids: string[]) => Promise<void>;
  refreshProfiles: () => Promise<void>;
  saveProfiles: (p: PrintProfile[]) => Promise<void>;
  savePresets: (p: LayoutPreset[]) => Promise<void>;
  toast: (kind: Toast["kind"], text: string, action?: Toast["action"]) => void;
  dismiss: (id: number) => void;
  select: (id: string | null) => void;
  setExportOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let toastId = 0;
const HISTORY = 60;

export const useApp = create<AppState>((set, get) => {
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    set({ saving: true });
    saveTimer = setTimeout(async () => {
      const p = get().project;
      if (!p) return;
      try {
        await api.saveProject(p);
        set({ saving: false, savedAt: Date.now() });
      } catch (e) {
        set({ saving: false });
        get().toast("error", errorText(e));
      }
    }, 500);
  };

  return {
    info: null,
    lang: detectLang(),
    view: "projects",
    panel: "cards",
    project: null,
    saving: false,
    savedAt: null,
    past: [],
    future: [],
    images: {},
    profiles: [],
    icc: [],
    presets: [],
    toasts: [],
    selectedCard: null,
    exportOpen: false,
    settingsOpen: false,

    init: async () => {
      try {
        const [info, profiles, icc, presets] = await Promise.all([
          api.appInfo(),
          api.printProfiles(),
          api.listIcc(),
          api.listPresets(),
        ]);
        set({ info, profiles, icc, presets });
      } catch (e) {
        get().toast("error", errorText(e));
      }
    },

    setLang: (lang) => {
      try {
        localStorage.setItem("lang", lang);
      } catch {
        /* ignore */
      }
      set({ lang });
    },
    setView: (view) => set({ view }),
    setPanel: (panel) => set({ panel }),

    openProject: async (id) => {
      try {
        const project = await api.loadProject(id);
        set({ project, view: "workspace", past: [], future: [], selectedCard: null, savedAt: Date.now() });
        await get().ensureImages(collectImageIds(project));
      } catch (e) {
        get().toast("error", errorText(e));
      }
    },

    createProject: async (name) => {
      const project = await api.newProject(name);
      set({ project, view: "workspace", panel: "cards", past: [], future: [], savedAt: Date.now() });
    },

    update: (fn, opts) => {
      const cur = get().project;
      if (!cur) return;
      const next = fn(structuredClone(cur));
      const history = opts?.history ?? true;
      set({
        project: next,
        past: history ? [...get().past.slice(-HISTORY), cur] : get().past,
        future: history ? [] : get().future,
      });
      scheduleSave();
    },

    undo: () => {
      const { past, project, future } = get();
      if (!past.length || !project) return;
      set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future] });
      scheduleSave();
    },

    redo: () => {
      const { past, project, future } = get();
      if (!future.length || !project) return;
      set({ project: future[0], future: future.slice(1), past: [...past, project] });
      scheduleSave();
    },

    addCards: async (entries) => {
      if (!entries.length) return;
      get().update((p) => {
        for (const e of entries) {
          const same = p.cards.find((c) => c.front === e.front && c.back === e.back);
          if (same) same.qty += e.qty;
          else p.cards.push(e);
        }
        return p;
      });
      await get().ensureImages(entries.flatMap((e) => [e.front, e.back ?? ""]).filter(Boolean));
    },

    ensureImages: async (ids) => {
      const missing = [...new Set(ids)].filter((id) => id && !get().images[id]);
      if (!missing.length) return;
      const got = await api.imagePaths(missing);
      set({ images: { ...get().images, ...got } });
      // Formats the Rust decoder cannot read (AVIF from Lorcast) are re-encoded here.
      const undecodable = Object.values(got).filter((i) => !i.meta.decodable);
      if (undecodable.length) await convertInWebview(undecodable);
    },

    refreshProfiles: async () => {
      const [profiles, icc] = await Promise.all([api.printProfiles(), api.listIcc()]);
      set({ profiles, icc });
    },
    saveProfiles: async (profiles) => {
      set({ profiles });
      await api.savePrintProfiles(profiles);
    },
    savePresets: async (presets) => {
      set({ presets });
      await api.savePresets(presets);
    },

    toast: (kind, text, action) => {
      const id = ++toastId;
      set({ toasts: [...get().toasts, { id, kind, text, action }] });
      setTimeout(() => get().dismiss(id), kind === "error" ? 9000 : 5000);
    },
    dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
    select: (selectedCard) => set({ selectedCard }),
    setExportOpen: (exportOpen) => set({ exportOpen }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  };
});

export function collectImageIds(p: Project): string[] {
  const ids = p.cards.flatMap((c) => [c.front, c.back ?? ""]);
  if (p.layout.duplex.defaultBack) ids.push(p.layout.duplex.defaultBack);
  return ids.filter(Boolean);
}

/** Decode with the webview (supports AVIF), send a PNG back, and swap ids in the project. */
async function convertInWebview(items: ImagePaths[]) {
  const s = useApp.getState();
  const swaps: Record<string, string> = {};
  for (const it of items) {
    try {
      const img = new Image();
      img.src = fileUrl(it.full);
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej("encode failed")), "image/png"));
      const meta = await api.convertImage(it.meta.id, new Uint8Array(await blob.arrayBuffer()));
      swaps[it.meta.id] = meta.id;
    } catch (e) {
      s.toast("error", `Could not convert image: ${errorText(e)}`);
    }
  }
  if (!Object.keys(swaps).length) return;
  const sw = (id?: string | null) => (id && swaps[id] ? swaps[id] : id);
  s.update(
    (p) => {
      p.cards = p.cards.map((c) => ({ ...c, front: sw(c.front)!, back: sw(c.back) }));
      p.layout.duplex.defaultBack = sw(p.layout.duplex.defaultBack);
      return p;
    },
    { history: false },
  );
  const got = await api.imagePaths(Object.values(swaps));
  useApp.setState({ images: { ...useApp.getState().images, ...got } });
}

/** Effective DPI of a card's artwork when printed at the project's card size. */
export function cardDpi(meta: { width: number } | undefined, widthMm: number, bleedMm = 0): number {
  if (!meta || !meta.width) return 0;
  return Math.round(meta.width / ((widthMm + 2 * bleedMm) / 25.4));
}
