"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { watchInvoices } from "@/lib/store";
import { useAppAuth, isPermissionDenied } from "@/lib/useAppAuth";
import { findSimilar } from "@/lib/similarity";
import { isCommittedStatus, type Invoice } from "@/lib/types";

/**
 * Custom Invoice: the same invoices as the Invoices tab. Tapping one opens its Custom Invoice form, where only the
 * printed information and notes can be filled in (company, dates, P.O., ship-to, notes, terms) and a print template
 * chosen. Drafts and voided invoices aren't listed — they aren't real sales to print.
 */
export default function CustomInvoicesPage() {
  const { notifyPossibleRevocation } = useAppAuth();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [query, setQuery] = useState("");

  useEffect(
    () => watchInvoices((all) => setInvoices(all.filter((i) => isCommittedStatus(i.paymentStatus))), (err) => isPermissionDenied(err) && notifyPossibleRevocation()),
    [notifyPossibleRevocation]
  );

  const q = query.trim();
  const shown = !q
    ? invoices
    : invoices.filter((i) => i.invoiceNumber.includes(q)).concat(
        findSimilar(q, invoices, (i) => i.customerName, 0.3)
          .map((m) => m.item)
          .filter((i) => !i.invoiceNumber.includes(q))
      );

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-5 pb-24 md:pb-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Custom Invoice</h1>
        <p className="text-sm text-slate-500 mt-1">Pick an invoice to add company info, dates and notes, and print it with a different template.</p>
      </div>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <input
          className="w-full rounded-xl border border-slate-300 bg-white pl-9 pr-3 py-2.5 text-base"
          placeholder="Tìm số hóa đơn hoặc tên khách..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
        {shown.map((inv) => (
          <Link
            key={inv.id}
            href={`/custom-invoices/${inv.id}`}
            className="flex items-center justify-between gap-3 px-4 md:px-5 py-3.5 hover:bg-slate-50 active:bg-slate-50"
          >
            <div className="min-w-0">
              <p className="font-medium text-slate-900 truncate">
                #{inv.invoiceNumber} · {inv.customerName}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                {new Date(inv.date).toLocaleDateString()} · {inv.items.length} item{inv.items.length === 1 ? "" : "s"}
              </p>
            </div>
            <p className="text-sm font-semibold text-slate-900 shrink-0">${inv.total.toFixed(2)}</p>
          </Link>
        ))}
        {shown.length === 0 && <p className="px-5 py-10 text-center text-sm text-slate-400">{q ? "No matching invoices." : "No invoices yet."}</p>}
      </div>
    </div>
  );
}
