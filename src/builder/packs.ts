// Asset packs on the UI side: status, install with progress, and pack fonts registered with
// the document so the canvas can draw with them.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface PackFont {
  family: string;
  file: string;
  weight: number;
  style: string;
}

export interface PackStatus {
  id: string;
  game: string;
  name: string;
  description: string;
  version: number;
  source: string;
  baseUrl: string;
  fonts: PackFont[];
  files: { path: string; url?: string; size: number }[];
  dir: string;
  installedFiles: number;
  totalFiles: number;
  totalBytes: number;
  complete: boolean;
}

let packs: PackStatus[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export async function refreshPacks(): Promise<PackStatus[]> {
  try {
    packs = (await invoke<PackStatus[]>("list_packs")) ?? [];
  } catch {
    packs = [];
  }
  loaded = true;
  emit();
  return packs;
}

export function usePacks(): PackStatus[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      if (!loaded) void refreshPacks();
      return () => listeners.delete(cb);
    },
    () => packs,
  );
}

export const packFor = (game: string) => packs.find((p) => p.game === game) ?? null;

export async function installPack(id: string): Promise<PackStatus> {
  const st = await invoke<PackStatus>("install_pack", { id });
  await refreshPacks();
  return st;
}

export async function removePack(id: string) {
  await invoke("remove_pack", { id });
  await refreshPacks();
}

export async function installPackZip(path: string) {
  const st = await invoke<PackStatus>("install_pack_zip", { path });
  await refreshPacks();
  return st;
}

const fontLoads = new Map<string, Promise<void>>();

/** Register a pack's fonts (downloading them on first use). Failures fall back silently. */
export function loadPackFonts(packId: string): Promise<void> {
  let p = fontLoads.get(packId);
  if (!p) {
    p = (async () => {
      const st = packs.find((x) => x.id === packId) ?? (await refreshPacks()).find((x) => x.id === packId);
      if (!st) return;
      await Promise.all(
        st.fonts.map(async (f) => {
          try {
            const raw = await invoke<ArrayBuffer | number[]>("read_pack_file", { pack: packId, path: f.file });
            const buf = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer;
            const face = new FontFace(f.family, buf, { weight: String(f.weight ?? 400), style: f.style ?? "normal" });
            await face.load();
            document.fonts.add(face);
          } catch (e) {
            console.warn("pack font failed", packId, f.family, e);
          }
        }),
      );
      void refreshPacks();
    })();
    p.catch(() => fontLoads.delete(packId));
    fontLoads.set(packId, p);
  }
  return p;
}

export const formatBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
