// Bilingual strings for the card builder (en / pt-BR), following the app language.
import { useApp } from "../lib/store";
import type { L } from "./tcg/types";

export function useBi() {
  const lang = useApp((s) => s.lang);
  const pt = lang === "pt-BR";
  const T = (en: string, ptText: string) => (pt ? ptText : en);
  T.l = (l: L) => (pt ? l.pt : l.en);
  T.lang = lang;
  return T;
}
