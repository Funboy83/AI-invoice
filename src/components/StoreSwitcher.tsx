"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronDown, Store } from "lucide-react";
import clsx from "clsx";
import { useAppAuth } from "@/lib/useAppAuth";
import { STORES, storeInfo } from "@/lib/stores";

/**
 * Shows which store everything on screen belongs to, and switches it. Switching remounts every page and the chat
 * (see useAppAuth / RequireAuth), so nothing from the previous store stays on screen. A detail page (one invoice,
 * one customer) belongs to the old store, so it goes back to that section's list.
 */
export default function StoreSwitcher({ size = "md", align = "left", className }: { size?: "sm" | "md"; align?: "left" | "right"; className?: string }) {
  const { storeId, setStoreId } = useAppAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = storeInfo(storeId);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [open]);

  const pick = (id: string) => {
    setOpen(false);
    if (id === storeId) return;
    const section = pathname.split("/").filter(Boolean)[0];
    const isDetail = pathname.split("/").filter(Boolean).length > 1;
    if (isDetail) router.replace(section ? `/${section}` : "/");
    setStoreId(id);
  };

  return (
    <div ref={ref} className={clsx("relative print:hidden", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Cửa hàng: ${current.name}. Bấm để đổi cửa hàng`}
        className={clsx(
          "flex items-center gap-1.5 rounded-full border font-semibold",
          current.badgeClass,
          size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"
        )}
      >
        <Store size={size === "sm" ? 13 : 15} />
        <span className="truncate">{current.name}</span>
        <ChevronDown size={size === "sm" ? 13 : 15} className={clsx("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div role="listbox" className={clsx("absolute z-50 mt-1.5 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg", align === "right" ? "right-0" : "left-0")}>
          <p className="px-3 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Đổi cửa hàng</p>
          {STORES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={s.id === storeId}
              onClick={() => pick(s.id)}
              className="flex w-full items-center gap-2.5 px-3 py-3 text-left text-sm text-slate-800 hover:bg-slate-50 active:bg-slate-100"
            >
              <span className={clsx("h-2.5 w-2.5 shrink-0 rounded-full", s.dotClass)} />
              <span className="flex-1">{s.name}</span>
              {s.id === storeId && <Check size={16} className="text-slate-500" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A slim band across the top of every page on phones, so the store is always visible (desktop has it in the sidebar). */
export function MobileStoreBar() {
  return (
    <div className="md:hidden print:hidden sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-slate-200 bg-white/95 px-4 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] backdrop-blur">
      <span className="text-xs text-slate-500">Cửa hàng</span>
      <StoreSwitcher size="sm" align="right" />
    </div>
  );
}
