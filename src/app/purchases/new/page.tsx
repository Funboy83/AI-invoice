"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { watchProducts } from "@/lib/store";
import { newOperationId, toDateKey } from "@/lib/businessApi";
import { createPurchaseApi, getVendorsApi, money } from "@/lib/purchaseApi";
import { useAppAuth } from "@/lib/useAppAuth";
import SearchCombobox from "@/components/SearchCombobox";
import VendorFormModal from "@/components/VendorFormModal";
import type { Product, Vendor } from "@/lib/types";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";

interface Line {
  key: string;
  productId: string;
  query: string;
  quantity: string;
  cost: string;
  unit: string;
}

const blankLine = (): Line => ({ key: newOperationId(), productId: "", query: "", quantity: "", cost: "", unit: "" });
const r2 = (n: number) => Math.round(n * 100) / 100;

// useSearchParams (?vendor=… from a vendor page) needs a Suspense boundary to build.
export default function NewPurchasePage() {
  return (
    <Suspense fallback={null}>
      <NewPurchaseForm />
    </Suspense>
  );
}

/** New purchase from a vendor: pick the vendor, enter their invoice #, add products with quantity and cost, save. */
function NewPurchaseForm() {
  const router = useRouter();
  const presetVendor = useSearchParams().get("vendor") ?? "";
  const { authedFetch, reportListenerError } = useAppAuth();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  const [vendorId, setVendorId] = useState("");
  const [vendorQuery, setVendorQuery] = useState("");
  const [newVendorName, setNewVendorName] = useState<string | null>(null);
  const [vendorInvoiceNumber, setVendorInvoiceNumber] = useState("");
  const [dateKey, setDateKey] = useState(() => toDateKey());
  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);
  const [shipping, setShipping] = useState("");
  const [discount, setDiscount] = useState("");
  const [notes, setNotes] = useState("");
  const [updateCost, setUpdateCost] = useState(true);
  const [payMode, setPayMode] = useState<"none" | "full" | "part">("none");
  const [partAmount, setPartAmount] = useState("");
  const [payMethod, setPayMethod] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // One stable id for this form's Save, reused on every retry: a lost response can never save the purchase twice.
  const [operationId] = useState(newOperationId);

  useEffect(() => {
    getVendorsApi(authedFetch)
      .then(({ vendors }) => {
        setVendors(vendors);
        const preset = vendors.find((v) => v.id === presetVendor);
        if (preset) {
          setVendorId(preset.id);
          setVendorQuery(preset.name);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load vendors."));
  }, [authedFetch, presetVendor]);

  useEffect(() => watchProducts((ps) => setProducts(ps.filter((p) => p.active)), reportListenerError), [reportListenerError]);

  const productById = new Map(products.map((p) => [p.id, p]));
  const updateLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // Same rounding as the server (each line to the cent, then the sum), so "Paid in full" always equals the saved total.
  const subtotal = r2(lines.reduce((s, l) => s + r2((Number(l.quantity) || 0) * (Number(l.cost) || 0)), 0));
  const total = r2(subtotal + (Number(shipping) || 0) - (Number(discount) || 0));
  const paidNow = payMode === "full" ? total : payMode === "part" ? Number(partAmount) || 0 : 0;

  async function save() {
    setError("");
    if (!vendorId) return setError("Pick a vendor (or add a new one).");
    const filled = lines.filter((l) => l.productId || l.query.trim() || l.quantity || l.cost);
    if (filled.length === 0) return setError("Add at least one product.");
    for (const [i, l] of filled.entries()) {
      if (!l.productId) return setError(`Line ${i + 1}: pick a product from the list.`);
      if (!(Number(l.quantity) > 0)) return setError(`Line ${i + 1}: enter how many you bought.`);
      if (l.cost === "" || !(Number(l.cost) >= 0)) return setError(`Line ${i + 1}: enter the cost for each one.`);
    }
    if (total < 0) return setError("The discount can't be more than the total.");
    if (paidNow < 0 || paidNow > total) return setError("Amount paid must be between $0 and the total.");

    setSaving(true);
    try {
      const { purchase, stockNotes } = await createPurchaseApi(
        authedFetch,
        {
          vendorId,
          vendorInvoiceNumber: vendorInvoiceNumber.trim(),
          dateKey,
          items: filled.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), cost: Number(l.cost), unit: l.unit || undefined })),
          shipping: Number(shipping) || 0,
          discount: Number(discount) || 0,
          notes,
          updateCost,
          paidNow: r2(paidNow),
          payMethod: paidNow > 0 ? payMethod : undefined,
        },
        operationId
      );
      const q = new URLSearchParams({ saved: "1" });
      for (const n of stockNotes) q.append("note", n);
      router.push(`/purchases/${purchase.id}?${q.toString()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the purchase.");
      setSaving(false);
    }
  }

  const input = "w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500";
  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-5 pb-24 md:pb-8">
      <Link href="/purchases" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft size={15} /> Purchases
      </Link>
      <h1 className="text-2xl font-semibold text-slate-900">New purchase</h1>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 space-y-4">
        <div>
          <label className="text-xs font-medium text-slate-600">Vendor</label>
          <div className="mt-1">
            <SearchCombobox
              items={vendors}
              getId={(v) => v.id}
              getLabel={(v) => v.name}
              getSubLabel={(v) => v.phone ?? ""}
              value={vendorQuery}
              onQueryChange={(q) => {
                setVendorQuery(q);
                setVendorId("");
              }}
              onSelect={(v) => {
                setVendorId(v.id);
                setVendorQuery(v.name);
              }}
              onCreateNew={(name) => setNewVendorName(name)}
              placeholder="Search or add a vendor"
              createLabel="Add new vendor"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-slate-600">Vendor&apos;s invoice # (from their bill)</label>
            <input className={`mt-1 ${input}`} placeholder="e.g. INV-55821" value={vendorInvoiceNumber} onChange={(e) => setVendorInvoiceNumber(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Date</label>
            <input type="date" className={`mt-1 ${input}`} value={dateKey} onChange={(e) => setDateKey(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Products bought</h2>
          <button onClick={() => setLines((ls) => [...ls, blankLine()])} className="flex items-center gap-1 text-sm font-medium text-indigo-600">
            <Plus size={15} /> Add line
          </button>
        </div>
        <p className="text-xs text-slate-500">Not in the list? Add it on the Products page first.</p>
        {lines.map((l, i) => {
          const p = productById.get(l.productId);
          const qty = Number(l.quantity) || 0;
          return (
            <div key={l.key} className="rounded-xl border border-slate-200 p-3 space-y-2">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <SearchCombobox
                    items={products}
                    getId={(x) => x.id}
                    getLabel={(x) => x.name}
                    getSubLabel={(x) => (x.cost !== undefined && x.cost !== null ? `cost ${money(x.cost)}` : "")}
                    value={l.query}
                    onQueryChange={(q) => updateLine(l.key, { query: q, productId: "" })}
                    onSelect={(x) => updateLine(l.key, { productId: x.id, query: x.name, unit: x.defaultUnit, cost: l.cost || (x.cost !== undefined && x.cost !== null ? String(x.cost) : "") })}
                    placeholder={`Product ${i + 1}`}
                  />
                </div>
                {lines.length > 1 && (
                  <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="mt-2.5 text-slate-400 hover:text-red-600" aria-label="Remove line">
                    <Trash2 size={17} />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[11px] text-slate-500">Quantity{l.unit ? ` (${l.unit})` : ""}</label>
                  <input type="number" inputMode="decimal" min={0} className={input} value={l.quantity} onChange={(e) => updateLine(l.key, { quantity: e.target.value })} />
                </div>
                <div>
                  <label className="text-[11px] text-slate-500">Cost each ($)</label>
                  <input type="number" inputMode="decimal" min={0} step="0.01" className={input} value={l.cost} onChange={(e) => updateLine(l.key, { cost: e.target.value })} />
                </div>
                <div>
                  <label className="text-[11px] text-slate-500">Line total</label>
                  <p className="py-2.5 text-base font-medium text-slate-900">{money(r2(qty * (Number(l.cost) || 0)))}</p>
                </div>
              </div>
              {p && (
                <p className="text-xs text-slate-500">
                  {p.quantity === undefined || p.quantity === null
                    ? `Stock not counted yet for this product. Saving starts counting it at ${qty}.`
                    : `In stock: ${p.quantity}${qty > 0 ? ` → ${r2(p.quantity + qty)} after saving` : ""}`}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 md:p-6 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-slate-600">Shipping / other fees ($)</label>
            <input type="number" inputMode="decimal" min={0} step="0.01" className={`mt-1 ${input}`} value={shipping} onChange={(e) => setShipping(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Discount ($)</label>
            <input type="number" inputMode="decimal" min={0} step="0.01" className={`mt-1 ${input}`} value={discount} onChange={(e) => setDiscount(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 pt-3">
          <span className="text-sm text-slate-600">Total</span>
          <span className="text-xl font-semibold text-slate-900">{money(total)}</span>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-600">Paid to the vendor now?</label>
          <div className="mt-1 flex rounded-lg border border-slate-300 p-1 text-sm font-medium">
            {(["none", "full", "part"] as const).map((m) => (
              <button key={m} onClick={() => setPayMode(m)} className={`flex-1 rounded-md px-3 py-1.5 ${payMode === m ? "bg-slate-900 text-white" : "text-slate-600"}`}>
                {{ none: "Not paid", full: "Paid in full", part: "Paid part" }[m]}
              </button>
            ))}
          </div>
        </div>
        {payMode === "part" && (
          <input type="number" inputMode="decimal" min={0} step="0.01" placeholder="Amount paid ($)" className={input} value={partAmount} onChange={(e) => setPartAmount(e.target.value)} />
        )}
        {payMode !== "none" && <input placeholder="How paid (cash, check #, Zelle…) — optional" className={input} value={payMethod} onChange={(e) => setPayMethod(e.target.value)} />}
        {payMode !== "full" && total > 0 && <p className="text-sm text-rose-700">You will owe this vendor {money(r2(total - paidNow))} on this purchase.</p>}

        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={updateCost} onChange={(e) => setUpdateCost(e.target.checked)} />
          <span>Update each product&apos;s cost to the price paid here</span>
        </label>

        <div>
          <label className="text-xs font-medium text-slate-600">Notes</label>
          <textarea rows={2} className={`mt-1 ${input}`} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>

      {error && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <Link href="/purchases" className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
          Cancel
        </Link>
        <button onClick={save} disabled={saving} className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {saving ? "Saving…" : "Save purchase"}
        </button>
      </div>

      {newVendorName !== null && (
        <VendorFormModal
          initialName={newVendorName}
          onClose={() => setNewVendorName(null)}
          onSaved={(v) => {
            setVendors((vs) => [...vs, v]);
            setVendorId(v.id);
            setVendorQuery(v.name);
          }}
        />
      )}
    </div>
  );
}
