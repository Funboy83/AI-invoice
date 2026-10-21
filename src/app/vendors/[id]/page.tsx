"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getVendorApi, money } from "@/lib/purchaseApi";
import { useAppAuth } from "@/lib/useAppAuth";
import VendorFormModal from "@/components/VendorFormModal";
import PurchaseRow from "@/components/PurchaseRow";
import { purchaseOwed, type Purchase, type Vendor } from "@/lib/types";
import { ArrowLeft, Pencil, Phone, Plus } from "lucide-react";
import { useT } from "@/lib/useLang";

type Tab = "unpaid" | "paid" | "all";

/** One vendor: contact info, how much you owe them, and their purchases split into Unpaid / Paid / All. */
export default function VendorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { authedFetch } = useAppAuth();
  const t = useT();
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("unpaid");
  const [editing, setEditing] = useState(false);

  // Bump `reloadTick` to fetch again after a change (save, payment, cancel).
  const [reloadTick, setReloadTick] = useState(0);
  const load = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getVendorApi(authedFetch, id);
        if (cancelled) return;
        setVendor(data.vendor);
        setPurchases(data.purchases);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load this vendor.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authedFetch, id, reloadTick]);

  const summary = useMemo(() => {
    const live = purchases.filter((p) => p.paymentStatus !== "void");
    const unpaid = live.filter((p) => purchaseOwed(p) > 0).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      unpaid,
      paid: live.filter((p) => p.paymentStatus === "paid"),
      all: purchases,
      owed: r2(unpaid.reduce((s, p) => s + p.balance, 0)),
      bought: r2(live.reduce((s, p) => s + p.total, 0)),
      paidTotal: r2(live.reduce((s, p) => s + p.amountPaid, 0)),
    };
  }, [purchases]);

  if (loading) return <div className="p-8 text-center text-sm text-slate-400">{t("Loading…")}</div>;
  if (!vendor) {
    return (
      <div className="p-8 text-center text-sm text-slate-500 space-y-3">
        <p>{error ? t(error) : t("This vendor was not found.")}</p>
        <Link href="/vendors" className="text-indigo-600">
          {t("Back to vendors")}
        </Link>
      </div>
    );
  }

  const shown = summary[tab];
  const tabs: { key: Tab; label: string }[] = [
    { key: "unpaid", label: `${t("Unpaid")} (${summary.unpaid.length})` },
    { key: "paid", label: `${t("Paid")} (${summary.paid.length})` },
    { key: "all", label: `${t("All")} (${summary.all.length})` },
  ];

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-5 pb-24 md:pb-8">
      <div className="flex items-center justify-between">
        <Link href="/vendors" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft size={15} /> {t("Vendors")}
        </Link>
        <div className="flex items-center gap-2">
          {vendor.phone && (
            <a href={`tel:${vendor.phone}`} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Phone size={14} /> {t("Call")}
            </a>
          )}
          <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <Pencil size={14} /> {t("Edit")}
          </button>
        </div>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{vendor.name}</h1>
          <p className="text-sm text-slate-500 mt-1">{[vendor.contactName, vendor.phone, vendor.email, vendor.address].filter(Boolean).join(" · ") || t("No contact info")}</p>
          {vendor.notes && <p className="text-sm text-slate-600 mt-2 whitespace-pre-line">{vendor.notes}</p>}
        </div>
        <Link
          href={`/purchases/new?vendor=${vendor.id}`}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={15} /> {t("New purchase")}
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className={`col-span-2 md:col-span-1 rounded-2xl border p-4 ${summary.owed > 0 ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50"}`}>
          <p className={`text-xs font-medium uppercase ${summary.owed > 0 ? "text-rose-700" : "text-emerald-700"}`}>{t("I owe this vendor")}</p>
          <p className={`text-2xl font-semibold mt-1 ${summary.owed > 0 ? "text-rose-800" : "text-emerald-800"}`}>{money(summary.owed)}</p>
          <p className="text-xs text-slate-600 mt-1">{summary.unpaid.length === 0 ? t("All paid up") : t(summary.unpaid.length > 1 ? "{n} unpaid purchases" : "{n} unpaid purchase", { n: summary.unpaid.length })}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium uppercase text-slate-500">{t("Total bought")}</p>
          <p className="text-lg font-semibold text-slate-900 mt-1">{money(summary.bought)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium uppercase text-slate-500">{t("Total paid")}</p>
          <p className="text-lg font-semibold text-slate-900 mt-1">{money(summary.paidTotal)}</p>
        </div>
      </div>

      <div className="flex rounded-xl border border-slate-200 bg-white p-1 text-sm font-medium">
        {tabs.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={`flex-1 rounded-lg px-3 py-2 ${tab === tb.key ? (tb.key === "unpaid" ? "bg-rose-500 text-white" : tb.key === "paid" ? "bg-emerald-600 text-white" : "bg-slate-900 text-white") : "text-slate-600"}`}
          >
            {tb.label}
          </button>
        ))}
      </div>
      {tab === "unpaid" && summary.unpaid.length > 0 && <p className="text-xs text-slate-500 -mt-2">{t("Oldest first. Tap a purchase to record a payment.")}</p>}

      <div className="space-y-2">
        {shown.map((p) => (
          <PurchaseRow key={p.id} p={p} />
        ))}
        {shown.length === 0 && <p className="text-center text-sm text-slate-400 py-10">{tab === "unpaid" ? t("Nothing owed.") : t("No purchases yet.")}</p>}
      </div>

      {editing && <VendorFormModal vendor={vendor} onClose={() => setEditing(false)} onSaved={() => void load()} />}
    </div>
  );
}
