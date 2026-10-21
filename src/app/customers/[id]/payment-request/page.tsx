"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Printer } from "lucide-react";
import { watchCustomers, watchInvoicesForCustomer } from "@/lib/store";
import { toDateKey } from "@/lib/businessApi";
import { isOpenInvoice, isStatementInvoice, statementOwed, statementTotals } from "@/lib/customerInvoices";
import { useAppAuth } from "@/lib/useAppAuth";
import { printPage } from "@/lib/printPage";
import { printFileName } from "@/lib/printFileName";
import { money } from "@/components/customInvoice/shared";
import StatementPrint from "@/components/StatementPrint";
import type { Customer, Invoice } from "@/lib/types";
import { useT } from "@/lib/useLang";

type Filter = "all" | "unpaid" | "paid";

const STATUS_LABEL: Record<string, string> = { unpaid: "Unpaid", partial: "Partial", paid: "Paid" };

const statusStyles: Record<string, string> = {
  unpaid: "bg-blue-100 text-blue-700",
  partial: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
};

/**
 * Payment request for one customer: tick the invoices to ask for (All / Unpaid / Paid), see the statement print update
 * live, then print it. Read-only — nothing here changes an invoice, payment or debt.
 */
export default function PaymentRequestPage() {
  const { id } = useParams<{ id: string }>();
  const { reportListenerError } = useAppAuth();
  const t = useT();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  // Unticked invoice ids; everything else is ticked, so invoices that arrive later start ticked.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [printedAt] = useState(() => Date.now());

  useEffect(() => {
    const onErr = reportListenerError;
    const u1 = watchCustomers(setCustomers, onErr);
    const u2 = watchInvoicesForCustomer(id, setInvoices, onErr);
    return () => {
      u1();
      u2();
    };
  }, [id, reportListenerError]);

  // Oldest first, the order to chase them in. Drafts and voids never go on a payment request.
  const listed = useMemo(
    () => (invoices ?? []).filter(isStatementInvoice).sort((a, b) => a.date - b.date || a.createdAt - b.createdAt),
    [invoices],
  );
  const counts = useMemo(
    () => ({ all: listed.length, unpaid: listed.filter(isOpenInvoice).length, paid: listed.filter((i) => i.paymentStatus === "paid").length }),
    [listed],
  );
  const shown = useMemo(
    () => listed.filter((i) => filter === "all" || (filter === "unpaid" ? isOpenInvoice(i) : i.paymentStatus === "paid")),
    [listed, filter],
  );
  const picked = useMemo(() => shown.filter((i) => !unticked.has(i.id)), [shown, unticked]);
  const totals = statementTotals(picked);

  const customer = customers?.find((c) => c.id === id);

  if (customers === null || invoices === null) {
    return <div className="p-8 text-center text-sm text-slate-400">{t("Loading…")}</div>;
  }
  if (!customer) {
    return (
      <div className="p-8 text-center text-sm text-slate-500 space-y-3">
        <p>{t("This customer was not found.")}</p>
        <Link href="/customers" className="text-indigo-600">
          {t("Back to customers")}
        </Link>
      </div>
    );
  }

  const toggle = (invoiceId: string) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(invoiceId)) next.delete(invoiceId);
      else next.add(invoiceId);
      return next;
    });
  const allTicked = shown.length > 0 && picked.length === shown.length;
  const toggleAll = () =>
    setUnticked((prev) => {
      const next = new Set(prev);
      for (const inv of shown) {
        if (allTicked) next.add(inv.id);
        else next.delete(inv.id);
      }
      return next;
    });
  // Switching the filter ticks everything it shows again, so each filter starts as "all of these".
  const pickFilter = (f: Filter) => {
    setFilter(f);
    setUnticked(new Set());
  };

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: t("All") },
    { key: "unpaid", label: t("Unpaid") },
    { key: "paid", label: t("Paid") },
  ];
  const statement = <StatementPrint customer={customer} invoices={picked} printedAt={printedAt} />;

  return (
    <>
      <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-4 pb-28 md:pb-8 print:hidden">
        <div className="flex items-center justify-between gap-3">
          <Link href={`/customers/${customer.id}`} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
            <ArrowLeft size={15} /> {customer.name}
          </Link>
          <button
            onClick={() => void printPage()}
            disabled={picked.length === 0}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <Printer size={15} /> {t("Print")}
          </button>
        </div>

        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{t("Payment request")}</h1>
          <p className="text-sm text-slate-500 mt-1">{t("Tick the invoices to put on the page. Nothing here changes an invoice or payment.")}</p>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
          <section className="space-y-3">
            <div className="flex rounded-xl border border-slate-200 bg-white p-1 text-sm font-medium">
              {filters.map((f) => (
                <button
                  key={f.key}
                  onClick={() => pickFilter(f.key)}
                  className={`flex-1 rounded-lg px-3 py-2 ${
                    filter === f.key ? (f.key === "unpaid" ? "bg-amber-500 text-white" : f.key === "paid" ? "bg-emerald-600 text-white" : "bg-slate-900 text-white") : "text-slate-600"
                  }`}
                >
                  {f.label} ({counts[f.key]})
                </button>
              ))}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
              <label className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-medium uppercase text-slate-500">
                <input type="checkbox" checked={allTicked} onChange={toggleAll} disabled={shown.length === 0} className="h-5 w-5 accent-emerald-600" />
                <span className="flex-1">{t("Invoice")}</span>
                <span>{t("Owed")}</span>
              </label>
              <div className="divide-y divide-slate-100">
                {shown.map((inv) => (
                  <label key={inv.id} className="flex items-center gap-3 px-4 py-3 active:bg-slate-50 cursor-pointer">
                    <input type="checkbox" checked={!unticked.has(inv.id)} onChange={() => toggle(inv.id)} className="h-5 w-5 shrink-0 accent-emerald-600" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">#{inv.invoiceNumber}</span>
                        <span className={`text-[10px] uppercase font-medium px-2 py-0.5 rounded-full ${statusStyles[inv.paymentStatus]}`}>{t(STATUS_LABEL[inv.paymentStatus] ?? inv.paymentStatus)}</span>
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {new Date(inv.date).toLocaleDateString()} · {t("Total")} {money(inv.total)}
                      </p>
                    </div>
                    <span className={`text-sm font-semibold ${statementOwed(inv) > 0 ? "text-amber-700" : "text-emerald-700"}`}>{money(statementOwed(inv))}</span>
                  </label>
                ))}
                {shown.length === 0 && (
                  <p className="text-center text-sm text-slate-400 py-8">
                    {filter === "unpaid" ? t("No unpaid invoices.") : filter === "paid" ? t("No paid invoices yet.") : t("No invoices yet.")}
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm">
              <div className="flex justify-between text-slate-700">
                <span>{t("{n} picked · billed {amount}", { n: totals.count, amount: money(totals.totalBilled) })}</span>
                <span>{t("paid {amount}", { amount: money(totals.totalPaid) })}</span>
              </div>
              <div className="mt-1 flex justify-between text-base font-semibold text-amber-800">
                <span>{t("Still owed")}</span>
                <span>{money(totals.totalOwed)}</span>
              </div>
            </div>
          </section>

          <section>
            <p className="mb-2 text-xs font-medium uppercase text-slate-500">{t("Print preview")}</p>
            <FitToWidth width={720}>
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">{statement}</div>
            </FitToWidth>
          </section>
        </div>
      </div>

      <div className="hidden print:block" data-print-root data-print-name={printFileName(customer.name, toDateKey())}>
        {statement}
      </div>
    </>
  );
}

/** "Tạp hóa Cô Lan" → "Tap hoa Co Lan", so the PDF file name keeps readable letters instead of underscores. */

/** Shows a fixed-width paper layout shrunk to fit its column, so the whole page is visible on a phone without side scrolling. */
function FitToWidth({ width, children }: { width: number; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState<number>();

  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const measure = () => {
      const s = Math.min(1, o.clientWidth / width);
      setScale(s);
      setHeight(i.offsetHeight * s);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, [width]);

  return (
    <div ref={outer} className="overflow-hidden" style={{ height }}>
      <div ref={inner} style={{ width, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        {children}
      </div>
    </div>
  );
}
