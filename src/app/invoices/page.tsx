"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { watchInvoices, watchProducts, watchCustomers } from "@/lib/store";
import { createInvoiceApi } from "@/lib/businessApi";
import ChatFilterBanner from "@/components/ChatFilterBanner";
import { useActionId } from "@/lib/useActionId";
import { useAppAuth, isPermissionDenied } from "@/lib/useAppAuth";
import { isInvoiceIncomplete, isOpenDelivery, type Invoice, type Product, type Customer, type InvoiceLineItem } from "@/lib/types";
import { Plus, X, Trash2, AlertTriangle, Truck, CalendarDays } from "lucide-react";
import SearchCombobox from "@/components/SearchCombobox";
import DeliveryBadge from "@/components/DeliveryBadge";
import CustomerFormModal from "@/components/CustomerFormModal";
import ProductQuickAddModal from "@/components/ProductQuickAddModal";

const statusStyles: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  unpaid: "bg-blue-100 text-blue-700",
  partial: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
  void: "bg-red-100 text-red-700",
};

type DateRange = "all" | "today" | "month" | "day";

/** Start/end (ms, local time) of the chosen date range; null = no date limit. */
function rangeBounds(range: DateRange, day: string): { start: number; end: number } | null {
  const now = new Date();
  if (range === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start: start.getTime(), end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime() };
  }
  if (range === "month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
    };
  }
  if (range === "day" && day) {
    const [y, m, d] = day.split("-").map(Number);
    return { start: new Date(y, m - 1, d).getTime(), end: new Date(y, m - 1, d + 1).getTime() };
  }
  return null;
}

const rangeButtons: { key: Exclude<DateRange, "day">; label: string }[] = [
  { key: "all", label: "All" },
  { key: "today", label: "Today" },
  { key: "month", label: "This month" },
];

interface DraftLine {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
}

// useSearchParams (filters opened from a chat shortcut) needs a Suspense boundary to build.
export default function InvoicesPage() {
  return (
    <Suspense fallback={null}>
      <InvoicesPageContent />
    </Suspense>
  );
}

function InvoicesPageContent() {
  const router = useRouter();
  const { authedFetch, notifyPossibleRevocation } = useAppAuth();
  const [allInvoices, setInvoices] = useState<Invoice[]>([]);
  // Opened from a chat shortcut: /invoices?customer=… (one customer's invoices) and/or ?status=unpaid (unpaid + partial).
  const searchParams = useSearchParams();
  const customerFilter = searchParams.get("customer");
  const unpaidOnly = searchParams.get("status") === "unpaid";
  // /invoices?tag=delivery: delivery orders still waiting for their final prices.
  const deliveryOnly = searchParams.get("tag") === "delivery";
  // Date filter on the invoice date: All (default), Today, This month, or one picked day.
  const [dateRange, setDateRange] = useState<DateRange>("all");
  const [pickedDay, setPickedDay] = useState("");
  const bounds = rangeBounds(dateRange, pickedDay);
  const invoices = allInvoices.filter(
    (i) =>
      (!bounds || (i.date >= bounds.start && i.date < bounds.end)) &&
      (!customerFilter || i.customerId === customerFilter) &&
      (!unpaidOnly || i.paymentStatus === "unpaid" || i.paymentStatus === "partial") &&
      (!deliveryOnly || isOpenDelivery(i))
  );
  const openDeliveries = allInvoices.filter(
    (i) => isOpenDelivery(i) && (!customerFilter || i.customerId === customerFilter)
  ).length;

  // Summary for the shown invoices. Void invoices are listed but not counted in the money totals.
  const counted = invoices.filter((i) => i.paymentStatus !== "void");
  const shownTotal = counted.reduce((sum, i) => sum + i.total, 0);
  const shownBalance = counted.reduce((sum, i) => sum + i.balance, 0);

  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [shipping, setShipping] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [notes, setNotes] = useState("");
  const [isDelivery, setIsDelivery] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  // Quick add opens a confirm popup (prefilled with the typed name); nothing is saved until OK there.
  const [quickAddCustomer, setQuickAddCustomer] = useState<string | null>(null);
  const [quickAddProduct, setQuickAddProduct] = useState<{ idx: number; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const createAction = useActionId(); // one stable id per open of the "New invoice" modal, reused across retries

  useEffect(() => {
    const onErr = (err: unknown) => isPermissionDenied(err) && notifyPossibleRevocation();
    const u1 = watchInvoices(setInvoices, onErr);
    const u2 = watchProducts(setProducts, onErr);
    const u3 = watchCustomers(setCustomers, onErr);
    return () => {
      u1();
      u2();
      u3();
    };
  }, [notifyPossibleRevocation]);

  const total = useMemo(() => {
    const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.price, 0);
    return subtotal + (Number(shipping) || 0) - (Number(discount) || 0);
  }, [lines, shipping, discount]);

  function openModal(delivery = false) {
    setCustomerId("");
    setCustomerName("");
    setShipping("0");
    setDiscount("0");
    setNotes("");
    setIsDelivery(delivery);
    setLines([]);
    setError("");
    createAction.start();
    setModalOpen(true);
  }

  function addLine() {
    setLines((prev) => [...prev, { productId: "", productName: "", quantity: 1, price: 0 }]);
  }

  function updateLine(idx: number, changes: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...changes } : l)));
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }


  async function handleCreate() {
    setError("");
    if (!customerName.trim()) return setError("Customer name is required.");
    if (lines.length === 0) return setError("Add at least one line item.");

    const items: InvoiceLineItem[] = [];
    for (const line of lines) {
      const product = products.find((p) => p.id === line.productId);
      if (!product) return setError(`Pick or add a product for "${line.productName || "one of the lines"}" first.`);
      if (line.quantity <= 0) return setError(`Quantity for ${product.name} must be greater than 0.`);
      items.push({
        productId: product.id,
        productName: product.name,
        quantity: line.quantity,
        unit: product.defaultUnit,
        price: line.price,
        lineTotal: Math.round(line.price * line.quantity * 100) / 100,
      });
    }

    setSaving(true);
    try {
      const existing = customerId
        ? customers.find((c) => c.id === customerId)
        : customers.find((c) => c.name.toLowerCase() === customerName.trim().toLowerCase());
      const { invoice, stockWarnings } = await createInvoiceApi(
        authedFetch,
        {
          customerId: existing?.id,
          customerName: existing?.name ?? customerName.trim(),
          items,
          shipping: Number(shipping) || 0,
          discount: Number(discount) || 0,
          notes,
          ...(isDelivery ? { delivery: true } : {}),
        },
        createAction.current()
      );
      setModalOpen(false);
      const warningQuery = stockWarnings?.length ? `?stockWarning=${encodeURIComponent(stockWarnings.join(" | "))}` : "";
      router.push(`/invoices/${invoice.id}${warningQuery}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create invoice.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 pb-24 md:pb-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Invoices</h1>
          <p className="text-sm text-slate-500 mt-1 hidden md:block">Create manually, or ask the AI secretary to draft one for you.</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Always-visible way in: opens the same form with "Delivery order" already ticked. */}
          <button
            onClick={() => openModal(true)}
            className="flex items-center gap-1.5 rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100"
          >
            <Truck size={16} /> Đơn giao
          </button>
          <button
            onClick={() => openModal()}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <Plus size={16} /> New
          </button>
        </div>
      </div>

      {/* Open deliveries were only reachable from a chat shortcut; this gives the list its own way in. */}
      {!deliveryOnly && openDeliveries > 0 && (
        <Link
          href="/invoices?tag=delivery"
          className="flex items-center justify-between rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-800 active:bg-violet-100"
        >
          <span className="flex items-center gap-2 font-medium">
            <Truck size={16} /> {openDeliveries} đơn giao chưa chốt giá
          </span>
          <span className="text-violet-600">Xem</span>
        </Link>
      )}

      {(customerFilter || unpaidOnly || deliveryOnly) && (
        <ChatFilterBanner
          label={[
            customerFilter ? `Invoice của ${invoices[0]?.customerName ?? "khách này"}` : "Tất cả invoice",
            unpaidOnly ? "chưa thanh toán" : "",
            deliveryOnly ? "đơn giao chưa chốt giá" : "",
          ].filter(Boolean).join(" · ")}
          clearHref="/invoices"
        />
      )}

      {/* Date filter + summary for the selected range */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl bg-slate-100 p-1">
            {rangeButtons.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => {
                  setDateRange(key);
                  setPickedDay("");
                }}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  dateRange === key ? "bg-white text-sky-700 shadow-sm" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <label
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm ${
              dateRange === "day" ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 bg-white text-slate-600"
            }`}
          >
            <CalendarDays size={15} />
            <input
              type="date"
              value={pickedDay}
              onChange={(e) => {
                setPickedDay(e.target.value);
                setDateRange(e.target.value ? "day" : "all");
              }}
              className="bg-transparent text-base md:text-sm focus:outline-none"
              aria-label="Pick a day"
            />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-2 md:gap-3">
          <div className="rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-500 p-3 md:p-4 text-white shadow-sm">
            <p className="text-[11px] md:text-xs font-medium uppercase tracking-wide text-white/80">Invoices</p>
            <p className="mt-1 text-xl md:text-2xl font-semibold">{invoices.length}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 md:p-4">
            <p className="text-[11px] md:text-xs font-medium uppercase tracking-wide text-emerald-700">Total</p>
            <p className="mt-1 text-lg md:text-2xl font-semibold text-emerald-800">${shownTotal.toFixed(2)}</p>
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 md:p-4">
            <p className="text-[11px] md:text-xs font-medium uppercase tracking-wide text-amber-700">Still owed</p>
            <p className="mt-1 text-lg md:text-2xl font-semibold text-amber-800">${shownBalance.toFixed(2)}</p>
          </div>
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-sky-50/70 text-sky-900/70 text-xs uppercase">
            <tr>
              <th className="text-left px-5 py-3 font-medium">Number</th>
              <th className="text-left px-5 py-3 font-medium">Customer</th>
              <th className="text-left px-5 py-3 font-medium">Date</th>
              <th className="text-right px-5 py-3 font-medium">Total (USD)</th>
              <th className="text-right px-5 py-3 font-medium">Balance (USD)</th>
              <th className="text-left px-5 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {invoices.map((inv) => (
              <tr key={inv.id} className="hover:bg-sky-50/50 cursor-pointer" onClick={() => router.push(`/invoices/${inv.id}`)}>
                <td className="px-5 py-3 font-medium text-slate-900">
                  <Link href={`/invoices/${inv.id}`}>#{inv.invoiceNumber}</Link>
                </td>
                <td className="px-5 py-3 text-slate-700">{inv.customerName}</td>
                <td className="px-5 py-3 text-slate-500">{new Date(inv.date).toLocaleDateString()}</td>
                <td className="px-5 py-3 text-right text-slate-900 font-medium">${inv.total.toFixed(2)}</td>
                <td className={`px-5 py-3 text-right font-medium ${inv.balance > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                  ${inv.balance.toFixed(2)}
                </td>
                <td className="px-5 py-3">
                  <span className={`text-[11px] uppercase font-medium px-2 py-0.5 rounded-full ${statusStyles[inv.paymentStatus]}`}>
                    {inv.paymentStatus}
                  </span>
                  {inv.delivery && (
                    <span className="ml-1.5">
                      <DeliveryBadge invoice={inv} />
                    </span>
                  )}
                  {isInvoiceIncomplete(inv) && (
                    <span className="ml-1.5 inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                      <AlertTriangle size={11} /> incomplete
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-10 text-center text-slate-400">
                  {bounds ? "No invoices in this date range." : "No invoices yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {invoices.map((inv) => (
          <Link
            key={inv.id}
            href={`/invoices/${inv.id}`}
            className={`block rounded-2xl border border-slate-200 border-l-4 bg-white p-4 shadow-sm active:bg-slate-50 ${
              inv.paymentStatus === "void" ? "border-l-red-300" : inv.balance > 0 ? "border-l-amber-400" : "border-l-emerald-400"
            }`}
          >
            <div className="flex items-center justify-between">
              <p className="font-medium text-slate-900">#{inv.invoiceNumber} · {inv.customerName}</p>
              <span className={`text-[10px] uppercase font-medium px-2 py-0.5 rounded-full ${statusStyles[inv.paymentStatus]}`}>
                {inv.paymentStatus}
              </span>
            </div>
            {inv.delivery && (
              <div className="mt-1">
                <DeliveryBadge invoice={inv} />
              </div>
            )}
            {isInvoiceIncomplete(inv) && (
              <p className="flex items-center gap-1 text-[11px] font-medium text-amber-700 mt-1">
                <AlertTriangle size={11} /> Incomplete — missing quantity/price
              </p>
            )}
            <div className="flex items-center justify-between mt-2 text-sm">
              <span className="text-slate-500">{new Date(inv.date).toLocaleDateString()}</span>
              <span className="font-semibold text-slate-900">${inv.total.toFixed(2)}</span>
            </div>
            {inv.balance > 0 && <p className="text-xs text-amber-600 mt-1">Balance: ${inv.balance.toFixed(2)}</p>}
          </Link>
        ))}
        {invoices.length === 0 && (
          <p className="text-center text-sm text-slate-400 py-10">{bounds ? "No invoices in this date range." : "No invoices yet."}</p>
        )}
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30">
          <div className="w-full md:max-w-2xl rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-900">{isDelivery ? "New delivery order (đơn giao)" : "New invoice"}</h2>
              <button onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-slate-700">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-600">Customer</label>
                <SearchCombobox
                  items={customers}
                  getId={(c) => c.id}
                  getLabel={(c) => c.name}
                  getSubLabel={(c) => c.phone ?? ""}
                  value={customerName}
                  onQueryChange={(q) => {
                    setCustomerName(q);
                    setCustomerId("");
                  }}
                  onSelect={(c) => {
                    setCustomerId(c.id);
                    setCustomerName(c.name);
                  }}
                  onCreateNew={(name) => setQuickAddCustomer(name)}
                  placeholder="Tìm hoặc thêm khách hàng..."
                  createLabel="Thêm khách hàng mới"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-600">Line items</label>
                  <button onClick={addLine} className="text-xs font-medium text-indigo-600 hover:underline">
                    + Add item
                  </button>
                </div>
                {products.length === 0 && (
                  <p className="text-xs text-slate-400">No products yet — type a name below to create one on the fly.</p>
                )}
                {lines.map((line, idx) => (
                  <div key={idx} className="flex flex-wrap items-start gap-2 rounded-lg border border-slate-200 p-2">
                    <div className="flex-1 min-w-[10rem]">
                      <SearchCombobox
                        items={products}
                        getId={(p) => p.id}
                        getLabel={(p) => p.name}
                        getSubLabel={(p) => `$${p.defaultPrice.toFixed(2)}`}
                        value={line.productName}
                        onQueryChange={(q) => updateLine(idx, { productId: "", productName: q })}
                        onSelect={(p) => updateLine(idx, { productId: p.id, productName: p.name, price: p.defaultPrice })}
                        onCreateNew={(name) => setQuickAddProduct({ idx, name })}
                        placeholder="Tìm hoặc thêm sản phẩm..."
                        createLabel="Thêm sản phẩm mới"
                      />
                    </div>
                    <input
                      type="number"
                      min={1}
                      className="w-16 rounded-md border border-slate-300 px-2 py-2.5 text-sm"
                      value={line.quantity}
                      onChange={(e) => updateLine(idx, { quantity: Number(e.target.value) })}
                    />
                    <input
                      type="number"
                      step="0.01"
                      className="w-20 rounded-md border border-slate-300 px-2 py-2.5 text-sm"
                      value={line.price}
                      onChange={(e) => updateLine(idx, { price: Number(e.target.value) })}
                    />
                    <span className="w-16 text-right text-sm font-medium text-slate-700 py-2.5">
                      ${(line.quantity * line.price).toFixed(2)}
                    </span>
                    <button onClick={() => removeLine(idx)} className="text-slate-400 hover:text-red-600 py-2.5">
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-slate-600">Shipping</label>
                  <input
                    type="number"
                    step="0.01"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    value={shipping}
                    onChange={(e) => setShipping(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600">Discount</label>
                  <input
                    type="number"
                    step="0.01"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    value={discount}
                    onChange={(e) => setDiscount(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-600">Notes (optional)</label>
                <textarea
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              <label className="flex items-start gap-2.5 rounded-lg border border-slate-200 p-3 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-violet-600"
                  checked={isDelivery}
                  onChange={(e) => setIsDelivery(e.target.checked)}
                />
                <span>
                  <span className="font-medium">Delivery order (đơn giao hàng)</span>
                  <span className="block text-xs text-slate-500">Prices can stay $0 now and be set later with &quot;Chốt giá&quot;.</span>
                </span>
              </label>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                <p className="text-sm text-slate-600">
                  Total: <span className="font-semibold text-slate-900">${total.toFixed(2)}</span>
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setModalOpen(false)}
                    className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreate}
                    disabled={saving}
                    className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {saving ? "Creating…" : "Create invoice"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {quickAddCustomer !== null && (
        <CustomerFormModal
          initialName={quickAddCustomer}
          onCreated={(c) => {
            setCustomerId(c.id);
            setCustomerName(c.name);
          }}
          onClose={() => setQuickAddCustomer(null)}
        />
      )}
      {quickAddProduct && (
        <ProductQuickAddModal
          initialName={quickAddProduct.name}
          initialPrice={lines[quickAddProduct.idx]?.price}
          onCreated={(p) =>
            updateLine(quickAddProduct.idx, { productId: p.id, productName: p.name, price: p.defaultPrice })
          }
          onClose={() => setQuickAddProduct(null)}
        />
      )}
    </div>
  );
}

