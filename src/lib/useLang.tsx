"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { DEFAULT_LANG, translate, type Lang, type Vars } from "./i18n/translate";

const STORAGE_KEY = "appLang";

// The chosen language lives in localStorage (remembered on this device). Kept as a tiny store so every screen, and
// other open tabs, switch together; the server render and first paint use the default (Vietnamese).
const listeners = new Set<() => void>();
let current: Lang | null = null;

function readSaved(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "en" || saved === "vi" ? saved : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG; // storage blocked (private mode)
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    current = readSaved();
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

const getSnapshot = () => (current ??= readSaved());
const getServerSnapshot = () => DEFAULT_LANG;

function saveLang(l: Lang) {
  current = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // not remembered, but still switched for this visit
  }
  listeners.forEach((fn) => fn());
}

interface LangCtx {
  lang: Lang;
  setLang(l: Lang): void;
  t(text: string, vars?: Vars): string;
}

const Ctx = createContext<LangCtx>({ lang: DEFAULT_LANG, setLang: saveLang, t: (s, v) => translate(DEFAULT_LANG, s, v) });

/** Holds the chosen language for the whole app (Vietnamese until she switches). */
export function LangProvider({ children }: { children: ReactNode }) {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useCallback((text: string, vars?: Vars) => translate(lang, text, vars), [lang]);
  const value = useMemo(() => ({ lang, setLang: saveLang, t }), [lang, t]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang() {
  return useContext(Ctx);
}

/** Shortcut for components that only need the translate function. */
export function useT() {
  return useContext(Ctx).t;
}
