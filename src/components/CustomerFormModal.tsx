"use client";

import { useState } from "react";
import { createCustomerApi, newOperationId, updateCustomerApi } from "@/lib/businessApi";
import { useAppAuth } from "@/lib/useAppAuth";
import type { Customer } from "@/lib/types";
import { X } from "lucide-react";

interface FormState {
  id?: string;
  name: string;
  aliases: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  shippingAddress: string;
  defaultShipping: string;
  notes: string;
}

const emptyForm: FormState = {
  name: "",
  aliases: "",
  contactName: "",
  email: "",
  phone: "",
  address: "",
  shippingAddress: "",
  defaultShipping: "",
  notes: "",
};

function formFor(c: Customer): FormState {
  return {
    id: c.id,
    name: c.name,
    aliases: c.aliases.join(", "),
    contactName: c.contactName ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    address: c.address ?? "",
    shippingAddress: c.shippingAddress ?? "",
    defaultShipping: c.defaultShipping !== undefined ? String(c.defaultShipping) : "",
    notes: c.notes ?? "",
  };
}

/**
 * Add / edit customer form, shared by the customers list ("Add customer"), the customer page ("Edit") and the invoice
 * form's quick add ("Thêm khách hàng mới"), where it opens prefilled with the typed name so it can be checked first.
 * Render it only while open: each mount is one new save action, so its operationId stays stable across retries of
 * THIS save (a lost-response retry can't create a second customer) and is fresh for the next open.
 */
export default function CustomerFormModal({
  customer,
  initialName,
  onCreated,
  onClose,
}: {
  customer?: Customer;
  /** Prefills the name of a new customer (quick add from the invoice form). */
  initialName?: string;
  /** Called with the saved customer after a successful create, before onClose. */
  onCreated?: (customer: Customer) => void;
  onClose: () => void;
}) {
  const { authedFetch } = useAppAuth();
  const [form, setForm] = useState<FormState>(() =>
    customer ? formFor(customer) : { ...emptyForm, name: initialName ?? "" }
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [operationId] = useState(newOperationId);

  async function handleSave() {
    if (!form.name.trim()) return setError("Name is required.");
    setSaving(true);
    setError("");
    const aliases = form.aliases
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    try {
      const shared = {
        name: form.name.trim(),
        contactName: form.contactName,
        email: form.email,
        phone: form.phone,
        address: form.address,
        shippingAddress: form.shippingAddress,
        defaultShipping: form.defaultShipping ? Number(form.defaultShipping) : undefined,
        notes: form.notes,
      };
      if (form.id) {
        await updateCustomerApi(authedFetch, form.id, shared, operationId);
      } else {
        const created = await createCustomerApi(authedFetch, { ...shared, aliases }, operationId);
        onCreated?.(created);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save customer.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center bg-black/30">
      <div className="w-full md:max-w-md rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-slate-900">{form.id ? "Edit customer" : "Add customer"}</h2>
          <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-700">
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
          {!form.id && (
            <div>
              <label className="text-xs font-medium text-slate-600">Aliases (comma-separated, e.g. Hoa Lee, chị Hoa Lee)</label>
              <input
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                value={form.aliases}
                onChange={(e) => setForm({ ...form, aliases: e.target.value })}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-600">Contact name</label>
              <input
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600">Phone</label>
              <input
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Email</label>
            <input
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Address</label>
            <input
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Shipping address (if different)</label>
            <input
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
              value={form.shippingAddress}
              onChange={(e) => setForm({ ...form, shippingAddress: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Default shipping fee (optional)</label>
            <input
              type="number"
              step="0.01"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
              value={form.defaultShipping}
              onChange={(e) => setForm({ ...form, defaultShipping: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Notes</label>
            <textarea
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => onClose()}
            className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : onCreated ? "OK" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
