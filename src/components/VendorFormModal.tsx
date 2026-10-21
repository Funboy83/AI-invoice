"use client";

import { useState } from "react";
import { newOperationId } from "@/lib/businessApi";
import { createVendorApi, updateVendorApi } from "@/lib/purchaseApi";
import { useAppAuth } from "@/lib/useAppAuth";
import type { Vendor } from "@/lib/types";
import { X } from "lucide-react";
import { useT } from "@/lib/useLang";

const fields = [
  { key: "name", label: "Vendor name" },
  { key: "contactName", label: "Contact name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "address", label: "Address" },
] as const;

type Form = Record<(typeof fields)[number]["key"] | "notes", string>;

/**
 * Add / edit vendor form. Render it only while open: each mount is one save action, so its operationId stays the
 * same across retries of THIS save (a lost response can't create the vendor twice).
 */
export default function VendorFormModal({ vendor, initialName, onClose, onSaved }: { vendor?: Vendor; initialName?: string; onClose: () => void; onSaved?: (v: Vendor) => void }) {
  const { authedFetch } = useAppAuth();
  const t = useT();
  const [form, setForm] = useState<Form>({
    name: vendor?.name ?? initialName ?? "",
    contactName: vendor?.contactName ?? "",
    phone: vendor?.phone ?? "",
    email: vendor?.email ?? "",
    address: vendor?.address ?? "",
    notes: vendor?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [operationId] = useState(newOperationId);

  async function save() {
    if (!form.name.trim()) return setError(t("Enter the vendor name."));
    setSaving(true);
    setError("");
    try {
      if (vendor) {
        await updateVendorApi(authedFetch, vendor.id, form, operationId);
        onSaved?.({ ...vendor, ...form });
      } else {
        onSaved?.(await createVendorApi(authedFetch, form, operationId));
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? t(e.message) : t("Failed to save vendor."));
    } finally {
      setSaving(false);
    }
  }

  const input = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500";
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30">
      <div className="w-full md:max-w-md rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-slate-900">{vendor ? t("Edit vendor") : t("Add vendor")}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3">
          {fields.map((f) => (
            <div key={f.key}>
              <label className="text-xs font-medium text-slate-600">{t(f.label)}</label>
              <input className={input} value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            </div>
          ))}
          <div>
            <label className="text-xs font-medium text-slate-600">{t("Notes")}</label>
            <textarea className={input} rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
            {t("Cancel")}
          </button>
          <button onClick={save} disabled={saving} className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {saving ? t("Saving…") : t("Save")}
          </button>
        </div>
      </div>
    </div>
  );
}
