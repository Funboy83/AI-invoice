"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getInvoice,
  watchInvoiceLogs,
  watchProducts,
  updateInvoiceWithLog,
  recordPayment,
  getPaymentsForInvoice,
  createProduct,
} from "@/lib/store";
import type { Invoice, InvoiceLog, InvoiceLineItem, Product, InvoiceStatus, Payment } from "@/lib/types";
import { isInvoiceIncomplete } from "@/lib/types";
import { ArrowLeft, Pencil, Trash2, Plus, Printer, DollarSign, AlertTriangle } from "lucide-react";
import SearchCombobox from "@/components/SearchCombobox";

const statusStyles: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  unpaid: "bg-blue-100 text-blue-700",
  partial: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
  void: "bg-red-100 text-red-700",
};

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<InvoiceLog[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  const [editing, setEditing] = useState(false);
  const [draftItems, setDraftItems] = useState<InvoiceLineItem[]>([]);
  const [draftShipping, setDraftShipping] = useState("0");
  const [draftDiscount, setDraftDiscount] = useState("0");
  const [draftStatus, setDraftStatus] = useState<InvoiceStatus>("unpaid");
  const [draftNotes, setDraftNotes] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("");
  const [payOpen, setPayOpen] = useState(false);

  async function load() {
    setLoading(true);
    const [inv, pays] = await Promise.all([getInvoice(id), getPaymentsForInvoice(id)]);
    setInvoice(inv);
    setPayments(pays);
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async load, not a derived-state anti-pattern
    load();
    const u1 = watchInvoiceLogs(id, setLogs);
    const u2 = watchProducts(setProducts);
    return () => {
      u1();
      u2();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function startEdit() {
    if (!invoice) return;
    setDraftItems(invoice.items.map((l) => ({ ...l })));
    setDraftShipping(String(invoice.shipping));
    setDraftDiscount(String(invoice.discount));
    setDraftStatus(invoice.paymentStatus);
    setDraftNotes(invoice.notes ?? "");
    setReason("");
    setError("");
    setEditing(true);
  }

  function updateLine(idx: number, changes: Partial<InvoiceLineItem>) {
    setDraftItems((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        const merged = { ...l, ...changes };
        merged.lineTotal = Math.round(merged.quantity * merged.price * 100) / 100;
        return merged;
      })
    );
  }

  function removeLine(idx: number) {
    setDraftItems((prev) => prev.filter((_, i) => i !== idx));
  }

  function addLine() {
    setDraftItems((prev) => [...prev, { productId: "", productName: "", quantity: 1, unit: "thùng", price: 0, lineTotal: 0 }]);
  }

  async function handleCreateProductForDraftLine(idx: number, name: string) {
    const line = draftItems[idx];
    const product = await createProduct({ name, defaultPrice: line?.price || 0, defaultUnit: line?.unit || "thùng" });
    updateLine(idx, { productId: product.id, productName: product.name, price: product.defaultPrice, unit: product.defaultUnit });
  }

  async function saveEdit() {
    if (!invoice) return;
    if (!reason.trim()) {
      setError("Please enter a reason for this edit — it will be saved to the audit log.");
      return;
    }
    if (draftItems.some((l) => !l.productId)) {
      setError("Pick or add a product for every line item first.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await updateInvoiceWithLog({
        invoiceId: invoice.id,
        items: draftItems,
        shipping: Number(draftShipping) || 0,
        discount: Number(draftDiscount) || 0,
        status: draftStatus,
        notes: draftNotes,
        actor: "user",
        reason: reason.trim(),
      });
      setEditing(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save changes.");
    } finally {
      setSaving(false);
    }
  }

  async function submitPayment() {
    if (!invoice || !payAmount || Number(payAmount) <= 0) return;
    setSaving(true);
    try {
      await recordPayment({ invoiceId: invoice.id, amount: Number(payAmount), method: payMethod, actor: "user" });
      setPayOpen(false);
      setPayAmount("");
      setPayMethod("");
      await load();
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading…</div>;
  if (!invoice) return <div className="p-8 text-slate-400 text-sm">Invoice not found.</div>;

  const draftSubtotal = draftItems.reduce((s, l) => s + l.lineTotal, 0);
  const draftTotal = draftSubtotal + (Number(draftShipping) || 0) - (Number(draftDiscount) || 0);

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6 pb-24 md:pb-8 print:p-0">
      <div className="flex items-center justify-between print:hidden">
        <button
          onClick={() => router.push("/invoices")}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft size={15} /> Back
        </button>
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Printer size={14} /> Print / PDF
          </button>
          {!editing && (
            <button
              onClick={() => setPayOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <DollarSign size={14} /> Record payment
            </button>
          )}
          {!editing && (
            <button
              onClick={startEdit}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <Pencil size={14} /> Edit
            </button>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 print:border-0 print:shadow-none">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Invoice #{invoice.invoiceNumber}</h1>
            <p className="text-sm text-slate-500 mt-1">{invoice.customerName}</p>
            <p className="text-xs text-slate-400 mt-1">{new Date(invoice.date).toLocaleString()}</p>
          </div>
          <span className={`text-xs uppercase font-medium px-2.5 py-1 rounded-full ${statusStyles[invoice.paymentStatus]}`}>
            {invoice.paymentStatus}
          </span>
        </div>

        {isInvoiceIncomplete(invoice) && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 print:hidden">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Incomplete temp draft — not ready to finalize</p>
              <p className="mt-0.5 text-amber-700">
                Missing quantity and/or price for: {invoice.items.filter((it) => it.incomplete).map((it) => it.productName).join(", ")}.
                Edit the item(s) to finish it, or set Status to Void below to delete this draft.
              </p>
            </div>
          </div>
        )}

        {invoice.originalOrderText && !editing && (
          <details className="mt-4 text-xs text-slate-500 print:hidden">
            <summary className="cursor-pointer select-none">Original message</summary>
            <pre className="whitespace-pre-wrap mt-1 bg-slate-50 rounded-lg p-3">{invoice.originalOrderText}</pre>
          </details>
        )}

        <div className="mt-6">
          {!editing ? (
            <>
              <table className="hidden md:table w-full text-sm">
                <thead className="text-xs uppercase text-slate-400">
                  <tr>
                    <th className="text-left py-2 font-medium">Item</th>
                    <th className="text-right py-2 font-medium">Qty</th>
                    <th className="text-left py-2 font-medium">Unit</th>
                    <th className="text-right py-2 font-medium">Price (USD)</th>
                    <th className="text-right py-2 font-medium">Total (USD)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {invoice.items.map((li, idx) => (
                    <tr key={idx} className={li.incomplete ? "bg-amber-50" : undefined}>
                      <td className="py-2.5 text-slate-800">
                        {li.productName}
                        {li.incomplete && (
                          <span className="ml-1.5 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 align-middle">
                            missing {li.quantity <= 0 ? "qty" : ""}
                            {li.quantity <= 0 && li.price <= 0 ? "/" : ""}
                            {li.price <= 0 ? "price" : ""}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-right text-slate-600">{li.quantity}</td>
                      <td className="py-2.5 text-slate-600">{li.unit}</td>
                      <td className="py-2.5 text-right text-slate-600">${li.price.toFixed(2)}</td>
                      <td className="py-2.5 text-right font-medium text-slate-900">${li.lineTotal.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Mobile stacked cards */}
              <div className="md:hidden space-y-2">
                {invoice.items.map((li, idx) => (
                  <div key={idx} className={`flex items-center justify-between rounded-xl border p-3 ${li.incomplete ? "border-amber-200 bg-amber-50" : "border-slate-100"}`}>
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {li.productName}
                        {li.incomplete && <span className="ml-1.5 text-[10px] font-medium text-amber-700">(incomplete)</span>}
                      </p>
                      <p className="text-xs text-slate-500">
                        {li.quantity} {li.unit} × ${li.price.toFixed(2)}
                      </p>
                    </div>
                    <p className="text-sm font-semibold text-slate-900">${li.lineTotal.toFixed(2)}</p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-slate-600 uppercase">Line items</p>
                <button onClick={addLine} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline">
                  <Plus size={13} /> Add item
                </button>
              </div>
              {draftItems.map((line, idx) => (
                <div key={idx} className="flex flex-wrap items-start gap-2 rounded-lg border border-slate-200 p-2">
                  <div className="flex-1 min-w-[10rem]">
                    <SearchCombobox
                      items={products}
                      getId={(p) => p.id}
                      getLabel={(p) => p.name}
                      getSubLabel={(p) => `$${p.defaultPrice.toFixed(2)}`}
                      value={line.productName}
                      onQueryChange={(q) => updateLine(idx, { productId: "", productName: q })}
                      onSelect={(p) => updateLine(idx, { productId: p.id, productName: p.name, price: p.defaultPrice, unit: p.defaultUnit })}
                      onCreateNew={(name) => handleCreateProductForDraftLine(idx, name)}
                      placeholder="Tìm hoặc thêm sản phẩm..."
                      createLabel="Thêm sản phẩm mới"
                    />
                  </div>
                  <input
                    type="number"
                    min={0}
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
                  <span className="w-16 text-right text-sm font-medium text-slate-700 py-2.5">${line.lineTotal.toFixed(2)}</span>
                  <button onClick={() => removeLine(idx)} className="text-slate-400 hover:text-red-600 py-2.5">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <div className="w-56 space-y-1 text-sm">
            <div className="flex justify-between text-slate-500">
              <span>Subtotal</span>
              <span>${(editing ? draftSubtotal : invoice.subtotal).toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-slate-500">
              <span>Shipping</span>
              <span>${(editing ? Number(draftShipping) || 0 : invoice.shipping).toFixed(2)}</span>
            </div>
            {(editing ? Number(draftDiscount) || 0 : invoice.discount) > 0 && (
              <div className="flex justify-between text-slate-500">
                <span>Discount</span>
                <span>-${(editing ? Number(draftDiscount) || 0 : invoice.discount).toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between font-semibold text-slate-900 text-base pt-1 border-t border-slate-100">
              <span>Total</span>
              <span>${(editing ? draftTotal : invoice.total).toFixed(2)}</span>
            </div>
            {!editing && (
              <>
                <div className="flex justify-between text-slate-500">
                  <span>Paid</span>
                  <span>${invoice.amountPaid.toFixed(2)}</span>
                </div>
                <div className="flex justify-between font-medium text-slate-900">
                  <span>Balance</span>
                  <span>${invoice.balance.toFixed(2)}</span>
                </div>
              </>
            )}
          </div>
        </div>

        {editing && (
          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4 print:hidden">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-slate-600">Shipping</label>
                <input
                  type="number"
                  step="0.01"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base"
                  value={draftShipping}
                  onChange={(e) => setDraftShipping(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600">Discount</label>
                <input
                  type="number"
                  step="0.01"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base"
                  value={draftDiscount}
                  onChange={(e) => setDraftDiscount(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600">Status</label>
              <select
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base"
                value={draftStatus}
                onChange={(e) => setDraftStatus(e.target.value as InvoiceStatus)}
              >
                <option value="draft">Draft</option>
                <option value="unpaid">Unpaid</option>
                <option value="partial">Partial</option>
                <option value="paid">Paid</option>
                <option value="void">Void</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600">Notes</label>
              <textarea
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base"
                rows={2}
                value={draftNotes}
                onChange={(e) => setDraftNotes(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600">Reason for edit (required, saved to audit log)</label>
              <input
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Customer requested quantity change"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(false)} className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={saving}
                className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        )}

        {invoice.notes && !editing && <p className="mt-4 text-sm text-slate-500 border-t border-slate-100 pt-3">{invoice.notes}</p>}
      </div>

      {payments.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 print:hidden">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Payments</h2>
          <div className="space-y-2">
            {payments.map((p) => (
              <div key={p.id} className="flex justify-between text-sm">
                <span className="text-slate-600">
                  {new Date(p.createdAt).toLocaleDateString()} {p.method ? `· ${p.method}` : ""}
                </span>
                <span className="font-medium text-slate-900">${p.amount.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white p-6 print:hidden">
        <h2 className="text-sm font-semibold text-slate-900 mb-3">Audit log</h2>
        <div className="space-y-3">
          {logs.map((log) => (
            <div key={log.id} className="flex gap-3 text-sm">
              <div className="w-1.5 h-1.5 mt-2 rounded-full bg-indigo-400 shrink-0" />
              <div>
                <p className="text-slate-700">
                  {log.message} <span className="text-xs text-slate-400 capitalize">— {log.actor}</span>
                </p>
                <p className="text-xs text-slate-400">{new Date(log.timestamp).toLocaleString()}</p>
              </div>
            </div>
          ))}
          {logs.length === 0 && <p className="text-sm text-slate-400">No log entries yet.</p>}
        </div>
      </div>

      {payOpen && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30">
          <div className="w-full md:max-w-sm rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Record payment</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-slate-600">Amount (balance: ${invoice.balance.toFixed(2)})</label>
                <input
                  type="number"
                  step="0.01"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600">Method (optional)</label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                  placeholder="cash, zelle, venmo…"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setPayOpen(false)} className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
                Cancel
              </button>
              <button
                onClick={submitPayment}
                disabled={saving}
                className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Record"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

