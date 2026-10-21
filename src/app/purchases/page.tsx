"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getPurchasesApi, getVendorsApi, money, purchaseMatches } from "@/lib/purchaseApi";
import { toDateKey } from "@/lib/businessApi";
import { useAppAuth } from "@/lib/useAppAuth";
import { printPage } from "@/lib/printPage";
import PurchaseRow from "@/components/PurchaseRow";
import { purchaseOwed, type Purchase, type Vendor } from "@/lib/types";
import { Plus, Printer, Search, Truck } from "lucide-react";
import { useT } from "@/lib/useLang";

type DateFilter = "all" | "month" | "lastMonth" | "range";
type StatusFilter = "all" | "unpaid" | "paid" | "void";

/** Purchase history: every purchase from vendors, searchable by vendor invoice #, filterable by date and vendor, printable. */
export default function PurchasesPage() {
  const { authedFetch } = useAppAuth();
  const t = useT();
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [from, setFrom] = useState(() => toDateKey());
  const [to, setTo] = useState(() => toDateKey());
  const [status, setStatus] = useState<StatusFilter>("all");

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPurchasesApi(authedFetch), getVendorsApi(authedFetch)])
      .then(([p, v]) => {
        if (cancelled) return;
        setPurchases(p.purchases);
        setVendors(v.vendors);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not load purchases."));
    return () => {
      cancelled = true;
    };
  }, [authedFetch]);

  const [rangeFrom, rangeTo] = useMemo((): [string, string] => {
    const now = new Date();
    if (dateFilter === "month") return [toDateKey(new Date(now.getFullYear(), now.getMonth(), 1).getTime()), "9999-12-31"];
    if (dateFilter === "lastMonth") {
      return [toDateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime()), toDateKey(new Date(now.getFullYear(), now.getMonth(), 0).getTime())];
    }
    if (dateFilter === "range") return from <= to ? [from, to] : [to, from];
    return ["0000-01-01", "9999-12-31"];
  }, [dateFilter, from, to]);

  const shown = (purchases ?? [])
    .filter((p) => p.dateKey >= rangeFrom && p.dateKey <= rangeTo)
    .filter((p) => !vendorId || p.vendorId === vendorId)
    .filter((p) => (status === "all" ? true : status === "unpaid" ? purchaseOwed(p) > 0 : p.paymentStatus === status))
    .filter((p) => purchaseMatches(p, search))
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey) || b.createdAt - a.createdAt);

  const live = shown.filter((p) => p.paymentStatus !== "void");
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const totalBought = r2(live.reduce((s, p) => s + p.total, 0));
  const totalOwed = r2(live.reduce((s, p) => s + purchaseOwed(p), 0));

  const pill = (active: boolean) => `whitespace-nowrap rounded-md px-3 py-1.5 ${active ? "bg-slate-900 text-white" : "text-slate-600"}`;
  const dateLabel = { all: t("All dates"), month: t("This month"), lastMonth: t("Last month"), range: `${rangeFrom} ${t("to")} ${rangeTo}` }[dateFilter];

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-5 pb-24 md:pb-8 print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{t("Purchases")}</h1>
          <p className="text-sm text-slate-500 mt-1">{t("Stock you buy from vendors. Saving a purchase adds it to your stock.")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/vendors" className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <Truck size={15} /> {t("Vendors")}
          </Link>
          <button onClick={() => void printPage()} className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <Printer size={15} /> {t("Print")}
          </button>
          <Link href="/purchases/new" className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            <Plus size={16} /> {t("New purchase")}
          </Link>
        </div>
      </div>

      <div className="space-y-2 print:hidden">
        <label className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 focus-within:ring-2 focus-within:ring-indigo-500">
          <Search size={16} className="text-slate-400" />
          <input
            className="w-full py-2.5 text-base focus:outline-none"
            placeholder={t("Search vendor invoice #, PO #, vendor or product")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <select className="rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base sm:w-56" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">{t("All vendors")}</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <div className="flex overflow-x-auto rounded-lg border border-slate-300 bg-white p-1 text-sm font-medium">
            <button onClick={() => setDateFilter("all")} className={pill(dateFilter === "all")}>{t("All")}</button>
            <button onClick={() => setDateFilter("month")} className={pill(dateFilter === "month")}>{t("This month")}</button>
            <button onClick={() => setDateFilter("lastMonth")} className={pill(dateFilter === "lastMonth")}>{t("Last month")}</button>
            <button onClick={() => setDateFilter("range")} className={pill(dateFilter === "range")}>{t("Pick dates")}</button>
          </div>
        </div>
        {dateFilter === "range" && (
          <div className="flex items-center gap-2 text-sm">
            <input type="date" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-base" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="text-slate-500">{t("to")}</span>
            <input type="date" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-base" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}
        <div className="flex overflow-x-auto rounded-lg border border-slate-300 bg-white p-1 text-sm font-medium">
          {(["all", "unpaid", "paid", "void"] as StatusFilter[]).map((s) => (
            <button key={s} onClick={() => setStatus(s)} className={`flex-1 ${pill(status === s)}`}>
              {t({ all: "All", unpaid: "Unpaid", paid: "Paid", void: "Cancelled" }[s])}
            </button>
          ))}
        </div>
      </div>

      {/* Printed header: what this list is. */}
      <div className="hidden print:block text-black">
        <h1 className="text-xl font-bold">{t("Purchases")}</h1>
        <p className="text-xs mt-1">
          {dateLabel}
          {vendorId && ` · ${vendors.find((v) => v.id === vendorId)?.name ?? ""}`}
          {search && ` · ${t("Search:")} ${search}`}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 print:rounded-none print:p-2">
          <p className="text-xs font-medium uppercase text-slate-500">{t("Bought ({n})", { n: live.length })}</p>
          <p className="text-lg font-semibold text-slate-900 mt-1">{money(totalBought)}</p>
        </div>
        <div className={`rounded-2xl border p-4 print:rounded-none print:p-2 ${totalOwed > 0 ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-white"}`}>
          <p className="text-xs font-medium uppercase text-rose-700">{t("Still owed")}</p>
          <p className="text-lg font-semibold text-rose-800 mt-1">{money(totalOwed)}</p>
        </div>
      </div>

      {error && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{t(error)}</p>}
      {purchases === null && !error && <p className="text-center text-sm text-slate-400 py-10">{t("Loading…")}</p>}

      <div className="space-y-2 print:space-y-0">
        {shown.map((p) => (
          <PurchaseRow key={p.id} p={p} showVendor />
        ))}
        {purchases !== null && shown.length === 0 && (
          <p className="text-center text-sm text-slate-400 py-10">{purchases.length === 0 ? t("No purchases yet. Tap New purchase to add the first one.") : t("No purchases match.")}</p>
        )}
      </div>
    </div>
  );
}
