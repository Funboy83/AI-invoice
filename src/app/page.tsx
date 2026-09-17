"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { watchProducts, watchCustomers, watchInvoices } from "@/lib/store";
import { isInvoiceIncomplete, type Product, type Customer, type Invoice } from "@/lib/types";
import { FileText, Boxes, Users, AlertTriangle } from "lucide-react";
import MobileChatHome from "@/components/MobileChatHome";

function StatCard({ label, value, icon: Icon }: { label: string; value: string; icon: typeof FileText }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 flex items-center gap-4">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
        <Icon size={20} />
      </div>
      <div>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="text-xl font-semibold text-slate-900">{value}</p>
      </div>
    </div>
  );
}

function DashboardContent() {
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);

  useEffect(() => {
    const u1 = watchProducts(setProducts);
    const u2 = watchCustomers(setCustomers);
    const u3 = watchInvoices(setInvoices);
    return () => {
      u1();
      u2();
      u3();
    };
  }, []);

  const revenue = invoices.filter((i) => i.paymentStatus !== "void" && i.paymentStatus !== "draft").reduce((s, i) => s + i.total, 0);
  const outstanding = invoices
    .filter((i) => i.paymentStatus === "unpaid" || i.paymentStatus === "partial")
    .reduce((s, i) => s + i.balance, 0);
  const incompleteDrafts = invoices.filter(isInvoiceIncomplete);

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <p className="text-sm text-slate-500 mt-1">Overview of your invoices, products, and customers.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total invoices" value={String(invoices.length)} icon={FileText} />
        <StatCard label="Revenue (USD)" value={`$${revenue.toFixed(2)}`} icon={FileText} />
        <StatCard label="Products" value={String(products.length)} icon={Boxes} />
        <StatCard label="Customers" value={String(customers.length)} icon={Users} />
      </div>

      {outstanding > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-600 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p className="font-medium">Outstanding balance</p>
            <p className="mt-0.5">${outstanding.toFixed(2)} across unpaid/partial invoices.</p>
          </div>
        </div>
      )}

      {incompleteDrafts.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-600 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p className="font-medium">
              {incompleteDrafts.length} incomplete temp {incompleteDrafts.length === 1 ? "draft" : "drafts"}
            </p>
            <p className="mt-0.5">
              Missing quantity/price on some items — open{" "}
              {incompleteDrafts.slice(0, 3).map((inv, i) => (
                <span key={inv.id}>
                  {i > 0 && ", "}
                  <Link href={`/invoices/${inv.id}`} className="underline">
                    #{inv.invoiceNumber}
                  </Link>
                </span>
              ))}{" "}
              to finish or void it.
            </p>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">Recent invoices</h2>
          <Link href="/invoices" className="text-xs font-medium text-indigo-600 hover:underline">
            View all
          </Link>
        </div>
        <div className="divide-y divide-slate-100">
          {invoices.slice(0, 6).map((inv) => (
            <Link
              key={inv.id}
              href={`/invoices/${inv.id}`}
              className="flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors"
            >
              <div>
                <p className="text-sm font-medium text-slate-900">
                  #{inv.invoiceNumber} · {inv.customerName}
                </p>
                <p className="text-xs text-slate-500">{new Date(inv.date).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-slate-900">${inv.total.toFixed(2)}</span>
                <span className="text-[11px] uppercase font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                  {inv.paymentStatus}
                </span>
              </div>
            </Link>
          ))}
          {invoices.length === 0 && (
            <p className="px-5 py-8 text-center text-sm text-slate-400">
              No invoices yet — create one manually or ask the AI secretary.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      <div className="hidden md:block">
        <DashboardContent />
      </div>
      <MobileChatHome />
    </>
  );
}
