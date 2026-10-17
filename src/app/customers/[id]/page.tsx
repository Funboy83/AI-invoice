"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { watchCustomers, watchInvoicesForCustomer } from "@/lib/store";
import { daysSince, summarizeCustomerInvoices } from "@/lib/customerInvoices";
import CustomerFormModal from "@/components/CustomerFormModal";
import DeliveryBadge from "@/components/DeliveryBadge";
import { useAppAuth, isPermissionDenied } from "@/lib/useAppAuth";
import type { Customer, Invoice } from "@/lib/types";
import { ArrowLeft, Pencil, Phone, ChevronRight, FileText } from "lucide-react";

const statusStyles: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  unpaid: "bg-blue-100 text-blue-700",
  partial: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
  void: "bg-red-100 text-red-700",
};

type Tab = "unpaid" | "paid" | "all";

/** One customer: who they are, what they owe, and their invoices split into Unpaid / Paid / All for follow-up. */
export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { notifyPossibleRevocation } = useAppAuth();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [tab, setTab] = useState<Tab>("unpaid");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const onErr = (err: unknown) => isPermissionDenied(err) && notifyPossibleRevocation();
    const u1 = watchCustomers(setCustomers, onErr);
    const u2 = watchInvoicesForCustomer(id, setInvoices, onErr);
    return () => {
      u1();
      u2();
    };
  }, [id, notifyPossibleRevocation]);

  const customer = customers?.find((c) => c.id === id);
  const summary = useMemo(() => summarizeCustomerInvoices(invoices ?? []), [invoices]);
  const shown = summary[tab];

  if (customers === null || invoices === null) {
    return <div className="p-8 text-center text-sm text-slate-400">Loading…</div>;
  }
  if (!customer) {
    return (
      <div className="p-8 text-center text-sm text-slate-500 space-y-3">
        <p>This customer was not found.</p>
        <Link href="/customers" className="text-indigo-600">
          Back to customers
        </Link>
      </div>
    );
  }

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "unpaid", label: "Unpaid", count: summary.unpaid.length },
    { key: "paid", label: "Paid", count: summary.paid.length },
    { key: "all", label: "All", count: summary.all.length },
  ];
  const back = `?back=${encodeURIComponent(`/customers/${customer.id}`)}`;

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-5 pb-24 md:pb-8">
      <div className="flex items-center justify-between">
        <button
          onClick={() => router.push("/customers")}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft size={15} /> Customers
        </button>
        <div className="flex items-center gap-2">
          {customer.phone && (
            <a
              href={`tel:${customer.phone}`}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <Phone size={14} /> Call
            </a>
          )}
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Pencil size={14} /> Edit
          </button>
        </div>
      </div>

      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{customer.name}</h1>
        <p className="text-sm text-slate-500 mt-1">
          {[customer.contactName, customer.phone, customer.address].filter(Boolean).join(" · ") || "No contact info"}
        </p>
        {customer.notes && <p className="text-sm text-slate-600 mt-2 whitespace-pre-line">{customer.notes}</p>}
      </div>

      {/* Balance summary: the numbers to chase. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div
          className={`col-span-2 md:col-span-1 rounded-2xl border p-4 ${
            summary.totalOwed > 0 ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"
          }`}
        >
          <p className={`text-xs font-medium uppercase ${summary.totalOwed > 0 ? "text-amber-700" : "text-emerald-700"}`}>Total owed</p>
          <p className={`text-2xl font-semibold mt-1 ${summary.totalOwed > 0 ? "text-amber-800" : "text-emerald-800"}`}>
            ${summary.totalOwed.toFixed(2)}
          </p>
          <p className="text-xs text-slate-600 mt-1">
            {summary.unpaid.length === 0
              ? "All paid up"
              : `${summary.unpaid.length} unpaid invoice${summary.unpaid.length > 1 ? "s" : ""}`}
          </p>
        </div>
        <SummaryCard
          label="Oldest unpaid"
          value={summary.oldestUnpaidDate ? `${daysSince(summary.oldestUnpaidDate)} days` : "—"}
          sub={summary.oldestUnpaidDate ? new Date(summary.oldestUnpaidDate).toLocaleDateString() : "Nothing waiting"}
        />
        <SummaryCard label="Total billed" value={`$${summary.totalBilled.toFixed(2)}`} sub={`${summary.unpaid.length + summary.paid.length} invoices`} />
        <SummaryCard label="Total paid" value={`$${summary.totalPaid.toFixed(2)}`} sub={`${summary.paid.length} fully paid`} />
      </div>

      <Link
        href={`/customers/${customer.id}/payment-request`}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-700 md:w-auto md:inline-flex"
      >
        <FileText size={16} /> Payment request
      </Link>

      {/* Unpaid / Paid / All */}
      <div className="flex rounded-xl border border-slate-200 bg-white p-1 text-sm font-medium">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-lg px-3 py-2 ${
              tab === t.key ? (t.key === "unpaid" ? "bg-amber-500 text-white" : t.key === "paid" ? "bg-emerald-600 text-white" : "bg-slate-900 text-white") : "text-slate-600"
            }`}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>
      {tab === "unpaid" && summary.unpaid.length > 0 && (
        <p className="text-xs text-slate-500 -mt-2">Oldest first. Tap an invoice to record a payment.</p>
      )}

      <div className="space-y-2">
        {shown.map((inv) => (
          <Link
            key={inv.id}
            href={`/invoices/${inv.id}${back}`}
            className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 active:bg-slate-50 hover:bg-slate-50"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-slate-900">#{inv.invoiceNumber}</p>
                <span className={`text-[10px] uppercase font-medium px-2 py-0.5 rounded-full ${statusStyles[inv.paymentStatus]}`}>
                  {inv.paymentStatus}
                </span>
                {inv.delivery && <DeliveryBadge invoice={inv} />}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                {new Date(inv.date).toLocaleDateString()}
                {(inv.paymentStatus === "unpaid" || inv.paymentStatus === "partial") && ` · ${daysSince(inv.date)} days ago`}
              </p>
            </div>
            <div className="text-right text-sm">
              <p className="font-semibold text-slate-900">${inv.total.toFixed(2)}</p>
              {inv.paymentStatus === "partial" && <p className="text-xs text-slate-500">Paid ${inv.amountPaid.toFixed(2)}</p>}
              {(inv.paymentStatus === "unpaid" || inv.paymentStatus === "partial") && (
                <p className="text-xs font-medium text-amber-700">Owes ${inv.balance.toFixed(2)}</p>
              )}
            </div>
            <ChevronRight size={16} className="shrink-0 text-slate-400" />
          </Link>
        ))}
        {shown.length === 0 && (
          <p className="text-center text-sm text-slate-400 py-10">
            {tab === "unpaid" ? "No unpaid invoices." : tab === "paid" ? "No paid invoices yet." : "No invoices yet."}
          </p>
        )}
      </div>

      {editing && <CustomerFormModal customer={customer} onClose={() => setEditing(false)} />}
    </div>
  );
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      <p className="text-lg font-semibold text-slate-900 mt-1">{value}</p>
      <p className="text-xs text-slate-500 mt-1">{sub}</p>
    </div>
  );
}
