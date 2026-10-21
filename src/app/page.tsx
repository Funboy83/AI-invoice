"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { watchProducts, watchCustomers, watchInvoices } from "@/lib/store";
import { useAppAuth } from "@/lib/useAppAuth";
import { isInvoiceIncomplete, type Product, type Customer, type Invoice } from "@/lib/types";
import { FileText, Boxes, Users, AlertTriangle } from "lucide-react";
import MobileChatHome from "@/components/MobileChatHome";
import PaymentStatusBadge from "@/components/PaymentStatusBadge";
import { useT } from "@/lib/useLang";

// Each tile has its own colour so the numbers are easy to tell apart; they match the menu (Invoices blue, Products orange, Customers green).
const statTones = {
  indigo: "from-indigo-500 to-violet-600 shadow-indigo-500/30",
  sky: "from-sky-500 to-blue-600 shadow-sky-500/30",
  amber: "from-amber-400 to-orange-500 shadow-amber-500/30",
  emerald: "from-emerald-500 to-teal-600 shadow-emerald-500/30",
};

function StatCard({ label, value, icon: Icon, tone = "indigo" }: { label: string; value: string; icon: typeof FileText; tone?: keyof typeof statTones }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 flex items-center gap-4">
      <div className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md ${statTones[tone]}`}>
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
  const { reportListenerError } = useAppAuth();
  const t = useT();
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);

  useEffect(() => {
    const onErr = reportListenerError;
    const u1 = watchProducts(setProducts, onErr);
    const u2 = watchCustomers(setCustomers, onErr);
    const u3 = watchInvoices(setInvoices, onErr);
    return () => {
      u1();
      u2();
      u3();
    };
  }, [reportListenerError]);

  const revenue = invoices.filter((i) => i.paymentStatus !== "void" && i.paymentStatus !== "draft").reduce((s, i) => s + i.total, 0);
  const outstanding = invoices
    .filter((i) => i.paymentStatus === "unpaid" || i.paymentStatus === "partial")
    .reduce((s, i) => s + i.balance, 0);
  const incompleteDrafts = invoices.filter(isInvoiceIncomplete);

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{t("Dashboard")}</h1>
        <p className="text-sm text-slate-500 mt-1">{t("Overview of your invoices, products, and customers.")}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label={t("Total invoices")} value={String(invoices.length)} icon={FileText} tone="sky" />
        <StatCard label={t("Revenue (USD)")} value={`$${revenue.toFixed(2)}`} icon={FileText} tone="indigo" />
        <StatCard label={t("Products")} value={String(products.length)} icon={Boxes} tone="amber" />
        <StatCard label={t("Customers")} value={String(customers.length)} icon={Users} tone="emerald" />
      </div>

      {outstanding > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-600 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p className="font-medium">{t("Outstanding balance")}</p>
            <p className="mt-0.5">{t("${amount} across unpaid/partial invoices.", { amount: outstanding.toFixed(2) })}</p>
          </div>
        </div>
      )}

      {incompleteDrafts.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-600 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p className="font-medium">
              {t(incompleteDrafts.length === 1 ? "{n} incomplete temp draft" : "{n} incomplete temp drafts", { n: incompleteDrafts.length })}
            </p>
            <p className="mt-0.5">
              {t("Missing quantity/price on some items — open")}{" "}
              {incompleteDrafts.slice(0, 3).map((inv, i) => (
                <span key={inv.id}>
                  {i > 0 && ", "}
                  <Link href={`/invoices/${inv.id}`} className="underline">
                    #{inv.invoiceNumber}
                  </Link>
                </span>
              ))}{" "}
              {t("to finish or void it.")}
            </p>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">{t("Recent invoices")}</h2>
          <Link href="/invoices" className="text-xs font-medium text-indigo-600 hover:underline">
            {t("View all")}
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
                <PaymentStatusBadge status={inv.paymentStatus} />
              </div>
            </Link>
          ))}
          {invoices.length === 0 && (
            <p className="px-5 py-8 text-center text-sm text-slate-400">
              {t("No invoices yet — create one manually or ask the AI secretary.")}
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
