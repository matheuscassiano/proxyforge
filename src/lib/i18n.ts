import { useApp } from "./store";
import { translate, type Key } from "./i18n-core";

export * from "./i18n-core";

export function useT() {
  const lang = useApp((s) => s.lang);
  return (key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars);
}
