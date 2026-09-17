"use client";

import { useEffect, useState } from "react";
import { watchProducts, createProduct, updateProduct } from "@/lib/store";
import type { Product } from "@/lib/types";
import { Plus, Pencil, X } from "lucide-react";

interface FormState {
  id?: string;
  name: string;
  aliases: string;
  defaultUnit: string;
  defaultPrice: string;
  cost: string;
  category: string;
  barcode: string;
  notes: string;
  active: boolean;
}

const emptyForm: FormState = {
  name: "",
  aliases: "",
  defaultUnit: "thùng",
  defaultPrice: "",
  cost: "",
  category: "",
  barcode: "",
  notes: "",
  active: true,
};

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => watchProducts(setProducts), []);

  function openCreate() {
    setForm(emptyForm);
    setModalOpen(true);
  }

  function openEdit(p: Product) {
    setForm({
      id: p.id,
      name: p.name,
      aliases: p.aliases.join(", "),
      defaultUnit: p.defaultUnit,
      defaultPrice: String(p.defaultPrice),
      cost: p.cost !== undefined ? String(p.cost) : "",
      category: p.category ?? "",
      barcode: p.barcode ?? "",
      notes: p.notes ?? "",
      active: p.active,
    });
    setModalOpen(true);
  }

  async function handleSave() {
    if (!form.name || form.defaultPrice === "") return;
    setSaving(true);
    const aliases = form.aliases
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    try {
      if (form.id) {
        await updateProduct(form.id, {
          name: form.name,
          defaultUnit: form.defaultUnit,
          defaultPrice: Number(form.defaultPrice),
          cost: form.cost ? Number(form.cost) : undefined,
          category: form.category,
          notes: form.notes,
          active: form.active,
        });
      } else {
        await createProduct({
          name: form.name,
          aliases,
          defaultUnit: form.defaultUnit,
          defaultPrice: Number(form.defaultPrice),
          cost: form.cost ? Number(form.cost) : undefined,
          category: form.category,
          barcode: form.barcode,
          notes: form.notes,
        });
      }
      setModalOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 pb-24 md:pb-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Products</h1>
          <p className="text-sm text-slate-500 mt-1">Catalog with aliases so the AI recognizes nicknames &amp; typos.</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={16} /> Add product
        </button>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-5 py-3 font-medium">Name</th>
              <th className="text-left px-5 py-3 font-medium">Aliases</th>
              <th className="text-right px-5 py-3 font-medium">Price</th>
              <th className="text-left px-5 py-3 font-medium">Unit</th>
              <th className="text-left px-5 py-3 font-medium">Category</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {products.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="px-5 py-3 font-medium text-slate-900">{p.name}</td>
                <td className="px-5 py-3 text-slate-500">
                  <div className="flex flex-wrap gap-1">
                    {p.aliases.slice(0, 4).map((a) => (
                      <span key={a} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px]">
                        {a}
                      </span>
                    ))}
                    {p.aliases.length === 0 && "—"}
                  </div>
                </td>
                <td className="px-5 py-3 text-right text-slate-900">${p.defaultPrice.toFixed(2)}</td>
                <td className="px-5 py-3 text-slate-500">{p.defaultUnit}</td>
                <td className="px-5 py-3 text-slate-500">{p.category || "—"}</td>
                <td className="px-5 py-3 text-right">
                  <button onClick={() => openEdit(p)} className="text-slate-400 hover:text-indigo-600">
                    <Pencil size={15} />
                  </button>
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-10 text-center text-slate-400">
                  No products yet. Add one manually, or paste an order to the AI and it will offer to create it.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {products.map((p) => (
          <button
            key={p.id}
            onClick={() => openEdit(p)}
            className="w-full text-left rounded-2xl border border-slate-200 bg-white p-4 active:bg-slate-50"
          >
            <div className="flex items-center justify-between">
              <p className="font-medium text-slate-900">{p.name}</p>
              <p className="font-semibold text-slate-900">${p.defaultPrice.toFixed(2)}</p>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {p.defaultUnit}
              {p.category ? ` · ${p.category}` : ""}
            </p>
            {p.aliases.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {p.aliases.slice(0, 4).map((a) => (
                  <span key={a} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                    {a}
                  </span>
                ))}
              </div>
            )}
          </button>
        ))}
        {products.length === 0 && (
          <p className="text-center text-sm text-slate-400 py-10">No products yet.</p>
        )}
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30">
          <div className="w-full md:max-w-md rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-900">{form.id ? "Edit product" : "Add product"}</h2>
              <button onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-slate-700">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-slate-600">Name</label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600">Aliases (comma-separated, e.g. bo huc, BH, red bull thai)</label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  value={form.aliases}
                  onChange={(e) => setForm({ ...form, aliases: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-slate-600">Price</label>
                  <input
                    type="number"
                    step="0.01"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    value={form.defaultPrice}
                    onChange={(e) => setForm({ ...form, defaultPrice: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600">Unit</label>
                  <input
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    value={form.defaultUnit}
                    onChange={(e) => setForm({ ...form, defaultUnit: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-slate-600">Cost (optional)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    value={form.cost}
                    onChange={(e) => setForm({ ...form, cost: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600">Category (optional)</label>
                  <input
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  />
                </div>
              </div>
              {!form.id && (
                <div>
                  <label className="text-xs font-medium text-slate-600">Barcode (optional)</label>
                  <input
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    value={form.barcode}
                    onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                  />
                </div>
              )}
              <div>
                <label className="text-xs font-medium text-slate-600">Notes (optional)</label>
                <textarea
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </div>
              {form.id && (
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={form.active}
                    onChange={(e) => setForm({ ...form, active: e.target.checked })}
                  />
                  Active
                </label>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setModalOpen(false)}
                className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
