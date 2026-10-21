"use client";

import { useState } from "react";
import { createProductApi, newOperationId } from "@/lib/businessApi";
import { useAppAuth } from "@/lib/useAppAuth";
import type { Product } from "@/lib/types";
import { X } from "lucide-react";
import { useT } from "@/lib/useLang";

const inputClass =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500";

/**
 * Quick add of a product from an invoice line: opens prefilled with the typed name (and the line's price/unit) so the
 * user can fix typos and fill in more details before anything is saved. Nothing is written until "OK".
 * Render it only while open: each mount is one new save action, so its operationId stays stable across retries of
 * THIS save (a lost-response retry can't create a second product) and is fresh for the next open.
 */
export default function ProductQuickAddModal({
  initialName,
  initialPrice,
  initialUnit,
  initialCost,
  stockFromPurchase,
  onCreated,
  onClose,
}: {
  initialName: string;
  initialPrice?: number;
  initialUnit?: string;
  initialCost?: number;
  /** From a purchase line: no Stock box; the product is saved not counted and the purchase's quantity becomes its stock. */
  stockFromPurchase?: boolean;
  onCreated: (product: Product) => void;
  onClose: () => void;
}) {
  const { authedFetch } = useAppAuth();
  const t = useT();
  const [name, setName] = useState(initialName);
  const [aliases, setAliases] = useState("");
  const [defaultUnit, setDefaultUnit] = useState(initialUnit || "thùng");
  const [defaultPrice, setDefaultPrice] = useState(initialPrice ? String(initialPrice) : "");
  const [cost, setCost] = useState(initialCost !== undefined ? String(initialCost) : "");
  const [quantity, setQuantity] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [operationId] = useState(newOperationId);

  async function handleSave() {
    if (!name.trim()) return setError(t("Name is required."));
    if (defaultPrice === "" || !(Number(defaultPrice) >= 0)) return setError(t("Enter a price (0 is OK)."));
    if (cost !== "" && !(Number(cost) >= 0)) return setError(t("Cost must be 0 or more."));
    if (quantity !== "" && !Number.isFinite(Number(quantity))) return setError(t("Stock must be a number."));
    setSaving(true);
    setError("");
    try {
      const product = await createProductApi(
        authedFetch,
        {
          name: name.trim(),
          aliases: aliases
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean),
          defaultUnit: defaultUnit.trim() || "thùng",
          defaultPrice: Number(defaultPrice),
          cost: cost !== "" ? Number(cost) : undefined,
          quantity: !stockFromPurchase && quantity !== "" ? Number(quantity) : undefined,
          category: category.trim(),
          notes: notes.trim(),
        },
        operationId
      );
      onCreated(product);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? t(e.message) : t("Failed to save product."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center bg-black/30">
      <div className="w-full md:max-w-md rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-slate-900">{t("Add new product")}</h2>
          <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>
        <p className="mb-4 text-xs text-slate-500">{t("Check the name and details, then tap OK to save.")}</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-slate-600">{t("Name")}</label>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">{t("Aliases (comma-separated, optional)")}</label>
            <input className={inputClass} value={aliases} onChange={(e) => setAliases(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-600">{t("Unit")}</label>
              <input className={inputClass} value={defaultUnit} onChange={(e) => setDefaultUnit(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600">{t("Price")}</label>
              <input
                type="number"
                step="0.01"
                min={0}
                inputMode="decimal"
                className={inputClass}
                value={defaultPrice}
                onChange={(e) => setDefaultPrice(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600">{t("Cost (optional)")}</label>
              <input
                type="number"
                step="0.01"
                min={0}
                inputMode="decimal"
                className={inputClass}
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </div>
            {!stockFromPurchase && (
              <div>
                <label className="text-xs font-medium text-slate-600">{t("Stock (blank = not tracked)")}</label>
                <input
                  type="number"
                  inputMode="numeric"
                  className={inputClass}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
            )}
          </div>
          {stockFromPurchase && <p className="text-xs text-slate-500">{t("Stock starts at the quantity you buy on this purchase.")}</p>}
          <div>
            <label className="text-xs font-medium text-slate-600">{t("Category (optional)")}</label>
            <input className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">{t("Notes")}</label>
            <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => onClose()}
            className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            {t("Cancel")}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? t("Saving…") : t("OK")}
          </button>
        </div>
      </div>
    </div>
  );
}
