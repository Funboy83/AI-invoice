"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { watchInvoices, watchProducts } from "@/lib/store";
import { productSales } from "@/lib/productSales";
import ProductFormModal from "@/components/ProductFormModal";
import PaymentStatusBadge from "@/components/PaymentStatusBadge";
import { useAppAuth } from "@/lib/useAppAuth";
import type { Invoice, Product } from "@/lib/types";
import { ArrowLeft, Pencil, X, Receipt, ChevronRight, User, ExternalLink } from "lucide-react";
import { useT } from "@/lib/useLang";

/**
 * One product: its name, nicknames, stock and prices, with Edit (the same form as the products list) and
 * "Invoice sold" — every invoice it is on, with the customer. Uses the products and invoices lists the app already
 * keeps in memory (src/lib/firebase.ts), so opening it costs no extra download.
 */
export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { reportListenerError } = useAppAuth();
  const t = useT();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [showSold, setShowSold] = useState(false);

  useEffect(() => {
    const u1 = watchProducts(setProducts, reportListenerError);
    const u2 = watchInvoices(setInvoices, reportListenerError);
    return () => {
      u1();
      u2();
    };
  }, [reportListenerError]);

  const product = products?.find((p) => p.id === id);
  const sales = useMemo(() => (product && invoices ? productSales(invoices, product) : null), [product, invoices]);

  if (products === null) {
    return <div className="p-8 text-center text-sm text-slate-400">{t("Loading…")}</div>;
  }
  if (!product) {
    return (
      <div className="p-8 text-center text-sm text-slate-500 space-y-3">
        <p>{t("This product was not found.")}</p>
        <Link href="/products" className="text-indigo-600">
          {t("Back to products")}
        </Link>
      </div>
    );
  }

  const close = () => router.push("/products");
  const tracked = product.quantity !== undefined;
  const lowStock = tracked && product.quantity! <= 0;
  const margin = product.cost !== undefined && product.defaultPrice > 0 ? product.defaultPrice - product.cost : undefined;
  const lastSale = sales?.rows.find((r) => r.status !== "draft" && r.status !== "void");

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-5 pb-24 md:pb-8">
      <div className="flex items-center justify-between">
        <button onClick={close} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft size={15} /> {t("Products")}
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Pencil size={14} /> {t("Edit")}
          </button>
          <button
            onClick={close}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <X size={14} /> {t("Close")}
          </button>
        </div>
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold text-slate-900">{product.name}</h1>
          {!product.active && (
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">{t("Inactive")}</span>
          )}
        </div>
        <p className="text-sm text-slate-500 mt-1">
          {[product.category, product.barcode ? t("Barcode {code}", { code: product.barcode }) : null].filter(Boolean).join(" · ") || t("No category")}
        </p>
      </div>

      {/* The main action: who bought this, on which invoice. */}
      <button
        onClick={() => setShowSold(true)}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold text-white shadow-sm hover:bg-indigo-700 md:w-auto md:inline-flex"
      >
        <Receipt size={18} /> {t("Invoice sold")}{sales ? ` (${sales.rows.length})` : ""}
      </button>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className={`col-span-2 md:col-span-1 rounded-2xl border p-4 ${lowStock ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"}`}>
          <p className={`text-xs font-medium uppercase ${lowStock ? "text-red-700" : "text-slate-500"}`}>{t("In stock")}</p>
          <p className={`text-2xl font-semibold mt-1 ${lowStock ? "text-red-700" : "text-slate-900"}`}>
            {tracked ? product.quantity : <span className="text-base text-slate-400">{t("Not counted")}</span>}
          </p>
          <p className="text-xs text-slate-500 mt-1">{tracked ? product.defaultUnit : t("Stock is not tracked")}</p>
        </div>
        <InfoCard label={t("Price")} value={`$${product.defaultPrice.toFixed(2)}`} sub={t("per {unit}", { unit: product.defaultUnit })} />
        <InfoCard
          label={t("Cost")}
          value={product.cost !== undefined ? `$${product.cost.toFixed(2)}` : "—"}
          sub={margin !== undefined ? t("Profit ${amount} each", { amount: margin.toFixed(2) }) : t("Not set")}
        />
        <InfoCard
          label={t("Sold")}
          value={sales ? `${sales.totals.quantity}${sales.totals.mixedUnits ? "" : ` ${product.defaultUnit}`}` : "…"}
          sub={
            sales
              ? sales.rows.length === 0
                ? t("Not sold yet")
                : `${t(sales.totals.invoiceCount === 1 ? "{n} invoice" : "{n} invoices", { n: sales.totals.invoiceCount })} · $${sales.totals.amount.toFixed(2)}`
              : t("Loading")
          }
        />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">{t("Aliases (nicknames the AI knows)")}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {product.aliases.map((a) => (
              <span key={a} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
                {a}
              </span>
            ))}
            {product.aliases.length === 0 && <span className="text-sm text-slate-400">{t("None yet")}</span>}
          </div>
        </div>
        {lastSale && (
          <div>
            <p className="text-xs font-medium uppercase text-slate-500">{t("Last sold")}</p>
            <p className="text-sm text-slate-700 mt-1">
              {t("{date} to {name} (#{n})", { date: new Date(lastSale.date).toLocaleDateString(), name: lastSale.customerName, n: lastSale.invoiceNumber })}
            </p>
          </div>
        )}
        {product.notes && (
          <div>
            <p className="text-xs font-medium uppercase text-slate-500">{t("Notes")}</p>
            <p className="text-sm text-slate-700 mt-1 whitespace-pre-line">{product.notes}</p>
          </div>
        )}
      </div>

      {editing && <ProductFormModal product={product} onClose={() => setEditing(false)} />}
      {showSold && <InvoiceSoldDialog product={product} sales={sales} onClose={() => setShowSold(false)} />}
    </div>
  );
}

function InfoCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      <p className="text-lg font-semibold text-slate-900 mt-1">{value}</p>
      <p className="text-xs text-slate-500 mt-1">{sub}</p>
    </div>
  );
}

/** Every invoice this product is on: number, date, customer, quantity, status; each with buttons to open the invoice or the customer. */
function InvoiceSoldDialog({
  product,
  sales,
  onClose,
}: {
  product: Product;
  sales: ReturnType<typeof productSales> | null;
  onClose: () => void;
}) {
  const back = `?back=${encodeURIComponent(`/products/${product.id}`)}`;
  // A slow phone connection can keep the first download of the invoice list going; after a while offer a reload.
  const t = useT();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full md:max-w-3xl rounded-t-2xl md:rounded-2xl bg-white shadow-xl max-h-[88vh] flex flex-col"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{t("Invoice sold")}</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              {product.name}
              {sales &&
                ` · ${t(sales.totals.invoiceCount === 1 ? "{n} finished invoice" : "{n} finished invoices", { n: sales.totals.invoiceCount })}, ${sales.totals.quantity}${
                  sales.totals.mixedUnits ? "" : ` ${product.defaultUnit}`
                }, $${sales.totals.amount.toFixed(2)}`}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" title={t("Close")}>
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto p-3 md:p-5">
          {!sales && (
            <div className="py-10 text-center text-sm text-slate-400 space-y-3">
              <p>{t("Loading invoices…")}</p>
              {slow && (
                <button onClick={() => window.location.reload()} className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700">
                  {t("Taking long? Tap to reload")}
                </button>
              )}
            </div>
          )}
          {sales && sales.rows.length === 0 && <p className="py-10 text-center text-sm text-slate-500">{t("Product not sold yet.")}</p>}

          {sales && sales.rows.length > 0 && (
            <>
              {/* Desktop table */}
              <table className="hidden md:table w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">{t("Invoice")}</th>
                    <th className="text-left px-3 py-2 font-medium">{t("Date")}</th>
                    <th className="text-left px-3 py-2 font-medium">{t("Customer")}</th>
                    <th className="text-right px-3 py-2 font-medium">{t("Qty")}</th>
                    <th className="text-right px-3 py-2 font-medium">{t("Amount")}</th>
                    <th className="text-left px-3 py-2 font-medium">{t("Status")}</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sales.rows.map((r) => (
                    <tr key={r.invoiceId} className={r.status === "void" ? "opacity-60" : ""}>
                      <td className="px-3 py-2.5 font-medium text-slate-900">#{r.invoiceNumber}</td>
                      <td className="px-3 py-2.5 text-slate-600">{new Date(r.date).toLocaleDateString()}</td>
                      <td className="px-3 py-2.5 text-slate-900">{r.customerName}</td>
                      <td className="px-3 py-2.5 text-right text-slate-900">
                        {r.quantity} <span className="text-slate-500">{r.unit}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-900">${r.lineTotal.toFixed(2)}</td>
                      <td className="px-3 py-2.5">
                        <PaymentStatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-1.5">
                          <Link
                            href={`/invoices/${r.invoiceId}${back}`}
                            className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                          >
                            <ExternalLink size={12} /> {t("View invoice")}
                          </Link>
                          {r.customerId && (
                            <Link
                              href={`/customers/${r.customerId}`}
                              className="flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            >
                              <User size={12} /> {t("Customer")}
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Phone list */}
              <div className="md:hidden space-y-2">
                {sales.rows.map((r) => (
                  <div key={r.invoiceId} className={`rounded-xl border border-slate-200 p-3 ${r.status === "void" ? "opacity-60" : ""}`}>
                    <Link href={`/invoices/${r.invoiceId}${back}`} className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-slate-900">#{r.invoiceNumber}</p>
                          <PaymentStatusBadge status={r.status} />
                        </div>
                        <p className="text-sm text-slate-700 mt-0.5 truncate">{r.customerName}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{new Date(r.date).toLocaleDateString()}</p>
                      </div>
                      <div className="text-right text-sm">
                        <p className="font-semibold text-slate-900">
                          {r.quantity} <span className="font-normal text-slate-500">{r.unit}</span>
                        </p>
                        <p className="text-xs text-slate-500">${r.lineTotal.toFixed(2)}</p>
                      </div>
                      <ChevronRight size={16} className="shrink-0 text-slate-400" />
                    </Link>
                    {r.customerId && (
                      <Link
                        href={`/customers/${r.customerId}`}
                        className="mt-2 inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700"
                      >
                        <User size={12} /> {t("Customer page")}
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
