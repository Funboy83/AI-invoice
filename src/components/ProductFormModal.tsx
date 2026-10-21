"use client";

import { useState } from "react";
import { createProductApi, newOperationId, updateProductApi } from "@/lib/businessApi";
import { useAppAuth } from "@/lib/useAppAuth";
import type { Product } from "@/lib/types";
import { X } from "lucide-react";

interface FormState {
  id?: string;
  name: string;
  aliases: string;
  defaultUnit: string;
  defaultPrice: string;
  cost: string;
  /** Blank = stock not counted yet; the first sale or purchase starts counting from 0. */
  quantity: string;
  /** Stock when the edit form opened: saving sends quantity only if the person changed it, so a sale made
   *  while the form was open is never overwritten with the older number. */
  startQuantity: string;
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
  quantity: "",
  startQuantity: "",
  category: "",
  barcode: "",
  notes: "",
  active: true,
};

function formFor(p: Product): FormState {
  return {
    id: p.id,
    name: p.name,
    aliases: p.aliases.join(", "),
    defaultUnit: p.defaultUnit,
    defaultPrice: String(p.defaultPrice),
    cost: p.cost !== undefined ? String(p.cost) : "",
    quantity: p.quantity !== undefined ? String(p.quantity) : "",
    startQuantity: p.quantity !== undefined ? String(p.quantity) : "",
    category: p.category ?? "",
    barcode: p.barcode ?? "",
    notes: p.notes ?? "",
    active: p.active,
  };
}

/**
 * Add / edit product form, shared by the products list ("Add product", the pencil) and the product page ("Edit").
 * Render it only while open: each mount is one new save action, so its operationId stays stable across retries of
 * THIS save (a lost-response retry can't create a second product) and is fresh for the next open.
 */
export default function ProductFormModal({ product, onClose }: { product?: Product; onClose: () => void }) {
  const { authedFetch } = useAppAuth();
  const [form, setForm] = useState<FormState>(() => (product ? formFor(product) : emptyForm));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [operationId] = useState(newOperationId);

  async function handleSave() {
    if (!form.name || form.defaultPrice === "") return;
    setSaving(true);
    setError("");
    const aliases = form.aliases
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    try {
      if (form.id) {
        await updateProductApi(
          authedFetch,
          form.id,
          {
            name: form.name,
            defaultUnit: form.defaultUnit,
            defaultPrice: Number(form.defaultPrice),
            cost: form.cost ? Number(form.cost) : undefined,
            quantity: form.quantity !== "" && form.quantity !== form.startQuantity ? Number(form.quantity) : undefined,
            category: form.category,
            notes: form.notes,
            active: form.active,
          },
          operationId
        );
      } else {
        await createProductApi(
          authedFetch,
          {
            name: form.name,
            aliases,
            defaultUnit: form.defaultUnit,
            defaultPrice: Number(form.defaultPrice),
            cost: form.cost ? Number(form.cost) : undefined,
            quantity: form.quantity !== "" ? Number(form.quantity) : undefined,
            category: form.category,
            barcode: form.barcode,
            notes: form.notes,
          },
          operationId
        );
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save product.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30">
      <div className="w-full md:max-w-md rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-slate-900">{form.id ? "Edit product" : "Add product"}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
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
          <div>
            <label className="text-xs font-medium text-slate-600">Stock quantity (leave blank to not track stock)</label>
            <input
              type="number"
              step="1"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              placeholder="Untracked"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              When set, stock is automatically deducted when this product is on a finalized invoice, and restored if the invoice is voided or the line is removed.
            </p>
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
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
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
  );
}
