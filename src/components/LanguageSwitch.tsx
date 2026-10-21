"use client";

import clsx from "clsx";
import { useLang } from "@/lib/useLang";

/** Two-button VI / EN switch. The choice is remembered on this device. */
export default function LanguageSwitch({ className }: { className?: string }) {
  const { lang, setLang, t } = useLang();
  return (
    <div role="group" aria-label={t("Language")} className={clsx("inline-flex shrink-0 rounded-full border border-slate-300 bg-white p-0.5 text-xs font-semibold print:hidden", className)}>
      {(["vi", "en"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          title={l === "vi" ? "Tiếng Việt" : "English"}
          className={clsx("rounded-full px-2.5 py-1", lang === l ? "bg-indigo-600 text-white" : "text-slate-500 hover:text-slate-800")}
        >
          {l === "vi" ? "VI" : "EN"}
        </button>
      ))}
    </div>
  );
}
