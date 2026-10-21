"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { watchCustomers, watchInvoices } from "@/lib/store";
import { useRouter, useSearchParams } from "next/navigation";
import ChatFilterBanner from "@/components/ChatFilterBanner";
import CustomerFormModal from "@/components/CustomerFormModal";
import { owedByCustomer } from "@/lib/customerInvoices";
import { useAppAuth } from "@/lib/useAppAuth";
import type { Customer, Invoice } from "@/lib/types";
import { Plus, ChevronRight, Search } from "lucide-react";
import { useT } from "@/lib/useLang";

/** Accent- and case-insensitive, so "hoa" finds "Chị Hòa". */
const normalizeSearch = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().trim();

// useSearchParams (filters opened from a chat shortcut) needs a Suspense boundary to build.
export default function CustomersPage() {
  return (
    <Suspense fallback={null}>
      <CustomersPageContent />
    </Suspense>
  );
}

function CustomersPageContent() {
  const router = useRouter();
  const { reportListenerError } = useAppAuth();
  const t = useT();
  const [allCustomers, setCustomers] = useState<Customer[]>([]);
  // Opened from a chat shortcut (/customers?id=…): show just that customer.
  const focusId = useSearchParams().get("id");

  const [allInvoices, setInvoices] = useState<Invoice[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [owingOnly, setOwingOnly] = useState(false);

  useEffect(() => {
    const onErr = reportListenerError;
    const u1 = watchCustomers(setCustomers, onErr);
    const u2 = watchInvoices(setInvoices, onErr);
    return () => {
      u1();
      u2();
    };
  }, [reportListenerError]);

  const owed = useMemo(() => owedByCustomer(allInvoices), [allInvoices]);
  const q = normalizeSearch(search);
  const customers = (focusId ? allCustomers.filter((c) => c.id === focusId) : allCustomers).filter(
    (c) =>
      (!owingOnly || (owed.get(c.id) ?? 0) > 0) &&
      (!q || [c.name, c.phone ?? "", ...c.aliases].some((s) => normalizeSearch(s).includes(q)))
  );
  const owingCount = allCustomers.filter((c) => (owed.get(c.id) ?? 0) > 0).length;

  const emptyText = allCustomers.length === 0 ? t("No customers yet.") : t("No customers match.");

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 pb-24 md:pb-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{t("Customers")}</h1>
          <p className="text-sm text-slate-500 mt-1">{t("Tap a customer to see their unpaid and paid invoices.")}</p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={16} /> {t("Add customer")}
        </button>
      </div>

      {focusId && <ChatFilterBanner label={t("Showing the customer opened from chat")} clearHref="/customers" />}

      {!focusId && (
        <div className="flex flex-col sm:flex-row gap-2">
          <label className="flex flex-1 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 focus-within:ring-2 focus-within:ring-indigo-500">
            <Search size={16} className="text-slate-400" />
            <input
              className="w-full py-2.5 text-base focus:outline-none"
              placeholder={t("Search name, nickname or phone")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <div className="flex rounded-lg border border-slate-300 bg-white p-1 text-sm font-medium">
            <button
              onClick={() => setOwingOnly(false)}
              className={`flex-1 rounded-md px-3 py-1.5 ${!owingOnly ? "bg-slate-900 text-white" : "text-slate-600"}`}
            >
              {t("All")}
            </button>
            <button
              onClick={() => setOwingOnly(true)}
              className={`flex-1 whitespace-nowrap rounded-md px-3 py-1.5 ${owingOnly ? "bg-amber-500 text-white" : "text-slate-600"}`}
            >
              {t("Owes money ({n})", { n: owingCount })}
            </button>
          </div>
        </div>
      )}

      <div className="hidden md:block rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-5 py-3 font-medium">{t("Name")}</th>
              <th className="text-left px-5 py-3 font-medium">{t("Aliases")}</th>
              <th className="text-left px-5 py-3 font-medium">{t("Phone")}</th>
              <th className="text-right px-5 py-3 font-medium">{t("Owes (USD)")}</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {customers.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => router.push(`/customers/${c.id}`)}>
                <td className="px-5 py-3 font-medium text-slate-900">
                  <Link href={`/customers/${c.id}`}>{c.name}</Link>
                </td>
                <td className="px-5 py-3 text-slate-500">
                  <div className="flex flex-wrap gap-1">
                    {c.aliases.slice(0, 4).map((a) => (
                      <span key={a} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px]">
                        {a}
                      </span>
                    ))}
                    {c.aliases.length === 0 && "—"}
                  </div>
                </td>
                <td className="px-5 py-3 text-slate-500">{c.phone || "—"}</td>
                <td className="px-5 py-3 text-right">
                  <OwedAmount amount={owed.get(c.id) ?? 0} />
                </td>
                <td className="px-5 py-3 text-right text-slate-400">
                  <ChevronRight size={16} className="inline" />
                </td>
              </tr>
            ))}
            {customers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-slate-400">
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="md:hidden space-y-3">
        {customers.map((c) => (
          <Link
            key={c.id}
            href={`/customers/${c.id}`}
            className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 active:bg-slate-50"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-slate-900">{c.name}</p>
              <p className="text-xs text-slate-500 mt-0.5">{c.phone || c.address || t("No contact info")}</p>
              {c.aliases.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {c.aliases.slice(0, 4).map((a) => (
                    <span key={a} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                      {a}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <OwedAmount amount={owed.get(c.id) ?? 0} />
            <ChevronRight size={16} className="shrink-0 text-slate-400" />
          </Link>
        ))}
        {customers.length === 0 && <p className="text-center text-sm text-slate-400 py-10">{emptyText}</p>}
      </div>

      {modalOpen && <CustomerFormModal onClose={() => setModalOpen(false)} />}
    </div>
  );
}

function OwedAmount({ amount }: { amount: number }) {
  const t = useT();
  if (amount <= 0) return <span className="text-xs text-slate-400">—</span>;
  return (
    <span className="shrink-0 text-right">
      <span className="block text-[10px] uppercase text-amber-600">{t("Owes")}</span>
      <span className="font-semibold text-amber-700">${amount.toFixed(2)}</span>
    </span>
  );
}
