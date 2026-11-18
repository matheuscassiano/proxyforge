// Fonts available in the card builder: bundled (offline, SIL OFL) + user-imported files.
import { invoke } from "@tauri-apps/api/core";

export interface FontDef {
  family: string;
  italic: boolean;
  bold: boolean;
  category: "serif" | "sans" | "display" | "fantasy";
  user?: boolean;
}

export const BUNDLED: FontDef[] = [
  { family: "Cinzel", italic: false, bold: true, category: "display" },
  { family: "EB Garamond", italic: true, bold: true, category: "serif" },
  { family: "Crimson Text", italic: true, bold: true, category: "serif" },
  { family: "Cormorant Garamond", italic: true, bold: true, category: "serif" },
  { family: "Merriweather", italic: true, bold: true, category: "serif" },
  { family: "Lora", italic: true, bold: true, category: "serif" },
  { family: "Playfair Display", italic: true, bold: true, category: "serif" },
  { family: "IM Fell English", italic: true, bold: false, category: "serif" },
  { family: "Roboto Slab", italic: false, bold: true, category: "serif" },
  { family: "Marcellus", italic: false, bold: false, category: "display" },
  { family: "Uncial Antiqua", italic: false, bold: false, category: "fantasy" },
  { family: "MedievalSharp", italic: false, bold: false, category: "fantasy" },
  { family: "Pirata One", italic: false, bold: false, category: "fantasy" },
  { family: "Bebas Neue", italic: false, bold: false, category: "display" },
  { family: "Oswald", italic: false, bold: true, category: "sans" },
  { family: "Montserrat", italic: true, bold: true, category: "sans" },
  { family: "Inter Variable", italic: false, bold: true, category: "sans" },
  { family: "JetBrains Mono Variable", italic: false, bold: true, category: "sans" },
];

let bundledLoaded: Promise<unknown> | null = null;

/** Load the bundled font CSS once (only when the builder opens). */
export function loadBundledFonts() {
  bundledLoaded ??= Promise.all([
    import("@fontsource/cinzel/400.css"),
    import("@fontsource/cinzel/700.css"),
    import("@fontsource/eb-garamond/400.css"),
    import("@fontsource/eb-garamond/700.css"),
    import("@fontsource/eb-garamond/400-italic.css"),
    import("@fontsource/eb-garamond/700-italic.css"),
    import("@fontsource/crimson-text/400.css"),
    import("@fontsource/crimson-text/700.css"),
    import("@fontsource/crimson-text/400-italic.css"),
    import("@fontsource/crimson-text/700-italic.css"),
    import("@fontsource/cormorant-garamond/400.css"),
    import("@fontsource/cormorant-garamond/700.css"),
    import("@fontsource/cormorant-garamond/400-italic.css"),
    import("@fontsource/merriweather/400.css"),
    import("@fontsource/merriweather/700.css"),
    import("@fontsource/merriweather/400-italic.css"),
    import("@fontsource/lora/400.css"),
    import("@fontsource/lora/700.css"),
    import("@fontsource/lora/400-italic.css"),
    import("@fontsource/playfair-display/400.css"),
    import("@fontsource/playfair-display/700.css"),
    import("@fontsource/playfair-display/400-italic.css"),
    import("@fontsource/im-fell-english/400.css"),
    import("@fontsource/im-fell-english/400-italic.css"),
    import("@fontsource/roboto-slab/400.css"),
    import("@fontsource/roboto-slab/700.css"),
    import("@fontsource/marcellus/400.css"),
    import("@fontsource/uncial-antiqua/400.css"),
    import("@fontsource/medievalsharp/400.css"),
    import("@fontsource/pirata-one/400.css"),
    import("@fontsource/bebas-neue/400.css"),
    import("@fontsource/oswald/400.css"),
    import("@fontsource/oswald/700.css"),
    import("@fontsource/montserrat/400.css"),
    import("@fontsource/montserrat/700.css"),
    import("@fontsource/montserrat/400-italic.css"),
  ]);
  return bundledLoaded;
}

export interface UserFont {
  family: string;
  path: string;
}

const loadedUser = new Set<string>();

/** Register user-imported font files with the document via FontFace. */
export async function loadUserFonts(fonts: UserFont[]) {
  for (const f of fonts) {
    if (loadedUser.has(f.path)) continue;
    try {
      const raw = await invoke<ArrayBuffer | number[]>("read_font", { path: f.path });
      const buf = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer;
      const face = new FontFace(f.family, buf);
      await face.load();
      document.fonts.add(face);
      loadedUser.add(f.path);
    } catch (e) {
      console.warn("font failed", f.family, e);
    }
  }
}

/** Make sure every font used by the given text styles is ready before drawing on canvas. */
export async function ensureFonts(specs: { font: string; weight: number; italic: boolean }[]) {
  await loadBundledFonts();
  const unique = new Set(specs.map((s) => `${s.italic ? "italic " : ""}${s.weight} 16px "${s.font}"`));
  await Promise.all([...unique].map((f) => document.fonts.load(f).catch(() => [])));
}
