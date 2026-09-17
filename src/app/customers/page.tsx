"use client";

import { useEffect, useState } from "react";
import { watchCustomers, createCustomer, updateCustomer } from "@/lib/store";
import type { Customer } from "@/lib/types";
import { Plus, Pencil, X } from "lucide-react";

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

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => watchCustomers(setCustomers), []);

  function openCreate() {
    setForm(emptyForm);
    setModalOpen(true);
  }

  function openEdit(c: Customer) {
    setForm({
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
    });
    setModalOpen(true);
  }

  async function handleSave() {
    if (!form.name) return;
    setSaving(true);
    const aliases = form.aliases
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    try {
      const shared = {
        name: form.name,
        contactName: form.contactName,
        email: form.email,
        phone: form.phone,
        address: form.address,
        shippingAddress: form.shippingAddress,
        defaultShipping: form.defaultShipping ? Number(form.defaultShipping) : undefined,
        notes: form.notes,
      };
      if (form.id) {
        await updateCustomer(form.id, shared);
      } else {
        await createCustomer({ ...shared, aliases });
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
          <h1 className="text-2xl font-semibold text-slate-900">Customers</h1>
          <p className="text-sm text-slate-500 mt-1">People and businesses you invoice, with nicknames the AI can recognize.</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={16} /> Add customer
        </button>
      </div>

      <div className="hidden md:block rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-5 py-3 font-medium">Name</th>
              <th className="text-left px-5 py-3 font-medium">Aliases</th>
              <th className="text-left px-5 py-3 font-medium">Phone</th>
              <th className="text-left px-5 py-3 font-medium">Address</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {customers.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="px-5 py-3 font-medium text-slate-900">{c.name}</td>
                <td className="px-5 py-3 text-slate-500">
                  <div className="flex flex-wrap gap-1">
                    {c.aliases.slice(0, 4).map((a) => (
                      <span key={a} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px]">
                        {a}
                      </span>
                    ))}
                    {c.aliases.length === 0 && "—"}
                  </div>
                </td>
                <td className="px-5 py-3 text-slate-500">{c.phone || "—"}</td>
                <td className="px-5 py-3 text-slate-500">{c.address || "—"}</td>
                <td className="px-5 py-3 text-right">
                  <button onClick={() => openEdit(c)} className="text-slate-400 hover:text-indigo-600">
                    <Pencil size={15} />
                  </button>
                </td>
              </tr>
            ))}
            {customers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-slate-400">
                  No customers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="md:hidden space-y-3">
        {customers.map((c) => (
          <button
            key={c.id}
            onClick={() => openEdit(c)}
            className="w-full text-left rounded-2xl border border-slate-200 bg-white p-4 active:bg-slate-50"
          >
            <p className="font-medium text-slate-900">{c.name}</p>
            <p className="text-xs text-slate-500 mt-0.5">{c.phone || c.address || "No contact info"}</p>
            {c.aliases.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {c.aliases.slice(0, 4).map((a) => (
                  <span key={a} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                    {a}
                  </span>
                ))}
              </div>
            )}
          </button>
        ))}
        {customers.length === 0 && <p className="text-center text-sm text-slate-400 py-10">No customers yet.</p>}
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30">
          <div className="w-full md:max-w-md rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-900">{form.id ? "Edit customer" : "Add customer"}</h2>
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

