import { vi } from "./vi";

/** App languages. Vietnamese is the main one (the default); English is the switch. */
export type Lang = "vi" | "en";
export const DEFAULT_LANG: Lang = "vi";

export type Vars = Record<string, string | number>;

/**
 * Every piece of screen text is written in English in the code and looked up here. In Vietnamese the English text is
 * the key into the dictionary (vi.ts); text with no Vietnamese entry yet simply shows in English. `{name}` marks are
 * filled from `vars` in both languages.
 */
export function translate(lang: Lang, text: string, vars?: Vars): string {
  const out = lang === "vi" ? (vi[text] ?? text) : text;
  return vars ? out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : out;
}
