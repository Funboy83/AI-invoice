"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { watchInvoices, watchProducts, watchCustomers, createInvoice, createCustomer, createProduct } from "@/lib/store";
import { isInvoiceIncomplete, type Invoice, type Product, type Customer, type InvoiceLineItem } from "@/lib/types";
import { Plus, X, Trash2, AlertTriangle } from "lucide-react";
import SearchCombobox from "@/components/SearchCombobox";

const statusStyles: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  unpaid: "bg-blue-100 text-blue-700",
  partial: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
  void: "bg-red-100 text-red-700",
};

interface DraftLine {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
}

export default function InvoicesPage() {
  const router = useRouter();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [shipping, setShipping] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const u1 = watchInvoices(setInvoices);
    const u2 = watchProducts(setProducts);
    const u3 = watchCustomers(setCustomers);
    return () => {
      u1();
      u2();
      u3();
    };
  }, []);

  const total = useMemo(() => {
    const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.price, 0);
    return subtotal + (Number(shipping) || 0) - (Number(discount) || 0);
  }, [lines, shipping, discount]);

  function openModal() {
    setCustomerId("");
    setCustomerName("");
    setShipping("0");
    setDiscount("0");
    setNotes("");
    setLines([]);
    setError("");
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

  async function handleCreateProductForLine(idx: number, name: string) {
    const line = lines[idx];
    const product = await createProduct({ name, defaultPrice: line?.price || 0, defaultUnit: "thùng" });
    updateLine(idx, { productId: product.id, productName: product.name, price: product.defaultPrice });
  }

  async function handleCreateCustomer(name: string) {
    const customer = await createCustomer({ name });
    setCustomerId(customer.id);
    setCustomerName(customer.name);
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
      const invoice = await createInvoice({
        customerId: existing?.id,
        customerName: existing?.name ?? customerName.trim(),
        items,
        shipping: Number(shipping) || 0,
        discount: Number(discount) || 0,
        notes,
        status: "unpaid",
        createdBy: "user",
        actor: "user",
      });
      setModalOpen(false);
      router.push(`/invoices/${invoice.id}`);
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
        <button
          onClick={openModal}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={16} /> New
        </button>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
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
              <tr key={inv.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => router.push(`/invoices/${inv.id}`)}>
                <td className="px-5 py-3 font-medium text-slate-900">
                  <Link href={`/invoices/${inv.id}`}>#{inv.invoiceNumber}</Link>
                </td>
                <td className="px-5 py-3 text-slate-700">{inv.customerName}</td>
                <td className="px-5 py-3 text-slate-500">{new Date(inv.date).toLocaleDateString()}</td>
                <td className="px-5 py-3 text-right text-slate-900 font-medium">${inv.total.toFixed(2)}</td>
                <td className="px-5 py-3 text-right text-slate-700">${inv.balance.toFixed(2)}</td>
                <td className="px-5 py-3">
                  <span className={`text-[11px] uppercase font-medium px-2 py-0.5 rounded-full ${statusStyles[inv.paymentStatus]}`}>
                    {inv.paymentStatus}
                  </span>
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
                  No invoices yet.
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
            className="block rounded-2xl border border-slate-200 bg-white p-4 active:bg-slate-50"
          >
            <div className="flex items-center justify-between">
              <p className="font-medium text-slate-900">#{inv.invoiceNumber} · {inv.customerName}</p>
              <span className={`text-[10px] uppercase font-medium px-2 py-0.5 rounded-full ${statusStyles[inv.paymentStatus]}`}>
                {inv.paymentStatus}
              </span>
            </div>
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
        {invoices.length === 0 && <p className="text-center text-sm text-slate-400 py-10">No invoices yet.</p>}
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30">
          <div className="w-full md:max-w-2xl rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-900">New invoice</h2>
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
                  onCreateNew={handleCreateCustomer}
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
                        onCreateNew={(name) => handleCreateProductForLine(idx, name)}
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
    </div>
  );
}

