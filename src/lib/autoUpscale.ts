// Non-destructive auto-upscaling: the Rust side swaps low-resolution artwork for its
// upscaled version in previews, exports and prints (project.upscale.auto). This module
// produces the missing upscales in the background, one at a time.
import { useEffect } from "react";
import { create } from "zustand";
import { api, errorText } from "./ipc";
import { useApp } from "./store";

interface QueueState {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  /** Bumped after each finished image: previews re-render with the sharper artwork. */
  version: number;
}

export const useUpscaleQueue = create<QueueState>(() => ({ running: false, total: 0, done: 0, failed: 0, version: 0 }));

let active = false;
let again = false;

async function drain() {
  if (active) {
    again = true;
    return;
  }
  active = true;
  try {
    do {
      again = false;
      const project = useApp.getState().project;
      if (!project?.upscale?.auto) break;
      const pending = await api.upscalePending(project);
      if (!pending.length) break;
      useUpscaleQueue.setState({ running: true, total: pending.length, done: 0, failed: 0 });
      for (const job of pending) {
        const p = useApp.getState().project;
        if (!p?.upscale?.auto || p.id !== project.id) {
          again = !!p?.upscale?.auto;
          break;
        }
        try {
          await api.upscaleImage({ imageId: job.imageId, model: p.upscale.model, scale: job.scale, tile: 0, gpu: null, tta: false });
          useUpscaleQueue.setState((s) => ({ done: s.done + 1, version: s.version + 1 }));
        } catch (e) {
          const msg = errorText(e);
          useUpscaleQueue.setState((s) => ({ done: s.done + 1, failed: s.failed + 1 }));
          // missing upscaler or a cancel: stop instead of failing every image
          if (/not installed|cancel/i.test(msg)) {
            useApp.getState().toast("error", msg);
            again = false;
            break;
          }
        }
      }
    } while (again);
  } catch (e) {
    useApp.getState().toast("error", errorText(e));
  } finally {
    active = false;
    useUpscaleQueue.setState({ running: false });
  }
}

/** Resolves once no auto-upscale is running (export and print wait for it). */
export function waitForUpscales(): Promise<void> {
  if (!active && !useUpscaleQueue.getState().running) return Promise.resolve();
  return new Promise((resolve) => {
    const un = useUpscaleQueue.subscribe((s) => {
      if (!s.running && !active) {
        un();
        resolve();
      }
    });
  });
}

/** Mount once in the workspace: keeps the auto-upscale queue in sync with the project. */
export function useAutoUpscale() {
  const project = useApp((s) => s.project);
  const profiles = useApp((s) => s.profiles);
  const dpi = (profiles.find((p) => p.id === project?.printProfileId) ?? profiles[0])?.dpi;
  const key = project?.upscale?.auto
    ? JSON.stringify([project.id, project.upscale, dpi, project.layout.cardSize, project.layout.duplex.defaultBack, project.cards.map((c) => [c.front, c.back, c.builtinBleedMm])])
    : "";
  useEffect(() => {
    if (!key) return;
    const h = setTimeout(drain, 600);
    return () => clearTimeout(h);
  }, [key]);
}

/**
 * Before an export or print at `dpi`: wait for the background queue, then produce any
 * upscale that DPI still needs. Failures are left to the export (it uses the original art).
 */
export async function ensureUpscales(dpi: number, onProgress: (done: number, total: number) => void): Promise<void> {
  await waitForUpscales();
  const project = useApp.getState().project;
  if (!project?.upscale?.auto) return;
  const pending = await api.upscalePending(project, dpi);
  for (let i = 0; i < pending.length; i++) {
    onProgress(i, pending.length);
    try {
      await api.upscaleImage({ imageId: pending[i].imageId, model: project.upscale.model, scale: pending[i].scale, tile: 0, gpu: null, tta: false });
    } catch (e) {
      if (/cancel/i.test(errorText(e))) throw e;
    }
  }
  if (pending.length) useUpscaleQueue.setState((s) => ({ version: s.version + 1 }));
}
