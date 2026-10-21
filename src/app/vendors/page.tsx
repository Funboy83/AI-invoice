"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getVendorsApi, money, normalizeSearch } from "@/lib/purchaseApi";
import { useAppAuth } from "@/lib/useAppAuth";
import VendorFormModal from "@/components/VendorFormModal";
import type { Vendor } from "@/lib/types";
import { ArrowLeft, ChevronRight, Plus, Search } from "lucide-react";
import { useT } from "@/lib/useLang";

/** The vendors you buy from, and how much you still owe each one. */
export default function VendorsPage() {
  const { authedFetch } = useAppAuth();
  const t = useT();
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [owed, setOwed] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [owingOnly, setOwingOnly] = useState(false);
  const [adding, setAdding] = useState(false);

  // Bump `reloadTick` to fetch again after a change (save, payment, cancel).
  const [reloadTick, setReloadTick] = useState(0);
  const load = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getVendorsApi(authedFetch);
        if (cancelled) return;
        setVendors(data.vendors);
        setOwed(data.owed);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load vendors.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authedFetch, reloadTick]);

  const q = normalizeSearch(search);
  const shown = (vendors ?? []).filter(
    (v) => (!owingOnly || (owed[v.id] ?? 0) > 0) && (!q || [v.name, v.phone ?? "", v.contactName ?? ""].some((s) => normalizeSearch(s).includes(q)))
  );
  const owingCount = (vendors ?? []).filter((v) => (owed[v.id] ?? 0) > 0).length;
  const totalOwed = Object.values(owed).reduce((s, n) => s + n, 0);

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-5 pb-24 md:pb-8">
      <Link href="/purchases" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft size={15} /> {t("Purchases")}
      </Link>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{t("Vendors")}</h1>
          <p className="text-sm text-slate-500 mt-1">
            {t("You owe vendors")} <span className="font-semibold text-rose-700">{money(Math.round(totalOwed * 100) / 100)}</span> {t("in total.")}
          </p>
        </div>
        <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          <Plus size={16} /> {t("Add vendor")}
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <label className="flex flex-1 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 focus-within:ring-2 focus-within:ring-indigo-500">
          <Search size={16} className="text-slate-400" />
          <input className="w-full py-2.5 text-base focus:outline-none" placeholder={t("Search vendor name or phone")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="flex rounded-lg border border-slate-300 bg-white p-1 text-sm font-medium">
          <button onClick={() => setOwingOnly(false)} className={`flex-1 rounded-md px-3 py-1.5 ${!owingOnly ? "bg-slate-900 text-white" : "text-slate-600"}`}>
            {t("All")}
          </button>
          <button onClick={() => setOwingOnly(true)} className={`flex-1 whitespace-nowrap rounded-md px-3 py-1.5 ${owingOnly ? "bg-rose-500 text-white" : "text-slate-600"}`}>
            {t("I owe ({n})", { n: owingCount })}
          </button>
        </div>
      </div>

      {error && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{t(error)}</p>}
      {vendors === null && !error && <p className="text-center text-sm text-slate-400 py-10">{t("Loading…")}</p>}

      <div className="space-y-2">
        {shown.map((v) => (
          <Link key={v.id} href={`/vendors/${v.id}`} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 hover:bg-slate-50 active:bg-slate-50">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-slate-900">{v.name}</p>
              <p className="text-xs text-slate-500 mt-0.5">{[v.contactName, v.phone].filter(Boolean).join(" · ") || t("No contact info")}</p>
            </div>
            {(owed[v.id] ?? 0) > 0 ? (
              <span className="text-right">
                <span className="block text-[10px] uppercase text-rose-600">{t("I owe")}</span>
                <span className="font-semibold text-rose-700">{money(owed[v.id])}</span>
              </span>
            ) : (
              <span className="text-xs text-slate-400">—</span>
            )}
            <ChevronRight size={16} className="shrink-0 text-slate-400" />
          </Link>
        ))}
        {vendors !== null && shown.length === 0 && (
          <p className="text-center text-sm text-slate-400 py-10">{vendors.length === 0 ? t("No vendors yet. Add the first one.") : t("No vendors match.")}</p>
        )}
      </div>

      {adding && <VendorFormModal onClose={() => setAdding(false)} onSaved={() => void load()} />}
    </div>
  );
}
