"use client";

import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Printer, Save, Pencil, Lock, Building2, FileText, User, Truck, StickyNote } from "lucide-react";
import clsx from "clsx";
import { getCustomerById, getInvoice } from "@/lib/store";
import { getInvoicePrintInfoApi, saveInvoicePrintInfoApi, toDateKey } from "@/lib/businessApi";
import { useAppAuth, isPermissionDenied } from "@/lib/useAppAuth";
import type { CustomInvoiceTemplate, Invoice, InvoicePrintInfo } from "@/lib/types";
import ProfessionalPrint from "@/components/customInvoice/ProfessionalPrint";
import SimplePrint from "@/components/customInvoice/SimplePrint";
import { money } from "@/components/customInvoice/shared";

type FormInfo = Omit<InvoicePrintInfo, "updatedAt">;

const TEMPLATES: { id: CustomInvoiceTemplate; label: string; hint: string }[] = [
  {
    id: "professional",
    label: "Professional",
    hint: "Big vendors (KiotViet style)",
  },
  { id: "simple", label: "Simple", hint: "Small vendors" },
];

const inputCls = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function Card({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        {icon} {title}
      </h2>
      {children}
    </section>
  );
}

// useSearchParams (?print=1 / ?edit=1 from the list's buttons) needs a Suspense boundary to build.
export default function CustomInvoicePage() {
  return (
    <Suspense fallback={null}>
      <CustomInvoiceContent />
    </Suspense>
  );
}

/**
 * Opens as a print preview with two choices: Print (as it is) or Edit (the information form). The list's Print
 * button lands here with ?print=1 and prints straight away; its Edit button lands with ?edit=1.
 */
function CustomInvoiceContent() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [editing, setEditing] = useState(searchParams.get("edit") === "1");
  const autoPrint = useRef(searchParams.get("print") === "1");
  const beforeEdit = useRef<FormInfo | null>(null);
  const { authedFetch, notifyPossibleRevocation } = useAppAuth();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [form, setForm] = useState<FormInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const inv = await getInvoice(invoiceId);
        if (!inv) throw new Error("Invoice not found.");
        const [{ info, defaults }, customer] = await Promise.all([
          getInvoicePrintInfoApi(authedFetch, invoiceId),
          inv.customerId ? getCustomerById(inv.customerId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setInvoice(inv);
        setSavedAt(info?.updatedAt ?? null);
        // First time for this invoice: company and terms from last time, customer details from the customer record.
        setForm(
          info ?? {
            invoiceId,
            template: "professional",
            from: defaults.from,
            billTo: {
              address: customer?.address ?? "",
              phone: customer?.phone ?? "",
            },
            shipTo: {
              name: customer?.contactName ?? "",
              address: customer?.shippingAddress ?? "",
              phone: "",
            },
            date: toDateKey(inv.date),
            dueDate: "",
            deliveryDate: "",
            po: "",
            notes: "",
            terms: defaults.terms,
          },
        );
      } catch (e) {
        if (isPermissionDenied(e)) notifyPossibleRevocation();
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Could not load this invoice.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authedFetch, invoiceId, notifyPossibleRevocation]);

  // Print button on the list: print as soon as the invoice and its saved info are on the page.
  useEffect(() => {
    if (!autoPrint.current || !invoice || !form) return;
    autoPrint.current = false;
    router.replace(`/custom-invoices/${invoiceId}`);
    setTimeout(() => window.print(), 50);
  }, [invoice, form, invoiceId, router]);

  if (loadError) return <div className="p-8 text-slate-400 text-sm">{loadError}</div>;
  if (!invoice || !form) return <div className="p-8 text-slate-400 text-sm">Loading…</div>;

  const set = (changes: Partial<FormInfo>) => setForm((f) => (f ? { ...f, ...changes } : f));

  async function save(thenPrint: boolean) {
    if (!form) return;
    if (!form.date) return setError("Pick the invoice date.");
    setSaving(true);
    setError("");
    try {
      const saved = await saveInvoicePrintInfoApi(authedFetch, form);
      setSavedAt(saved.updatedAt);
      setEditing(false);
      if (thenPrint) window.print();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  const preview = form.template === "simple" ? <SimplePrint invoice={invoice} info={form} /> : <ProfessionalPrint invoice={invoice} info={form} />;

  return (
    <>
      <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-5 pb-28 md:pb-8 print:hidden">
        <div className="flex items-center justify-between gap-3">
          <button onClick={() => router.push("/custom-invoices")} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
            <ArrowLeft size={15} /> Back
          </button>
          {editing ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (beforeEdit.current) setForm(beforeEdit.current);
                  setError("");
                  setEditing(false);
                }}
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={() => save(false)}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <Save size={15} /> Save
              </button>
              <button
                onClick={() => save(true)}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <Printer size={15} /> {saving ? "Saving…" : "Save & Print"}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  beforeEdit.current = form;
                  setEditing(true);
                }}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <Pencil size={15} /> Edit
              </button>
              <button
                onClick={() => window.print()}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
              >
                <Printer size={15} /> Print
              </button>
            </div>
          )}
        </div>

        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Custom Invoice #{invoice.invoiceNumber}</h1>
          <p className="text-sm text-slate-500 mt-1">
            {invoice.customerName} ·{" "}
            <Link href={`/invoices/${invoice.id}`} className="text-indigo-600 hover:underline">
              open invoice
            </Link>
            {savedAt ? ` · saved ${new Date(savedAt).toLocaleString()}` : " · not saved yet"}
          </p>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}

        {/* Template picker */}
        <div className="grid grid-cols-2 gap-3">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => set({ template: t.id })}
              className={clsx(
                "rounded-xl border p-3 text-left",
                form.template === t.id ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500" : "border-slate-200 bg-white hover:bg-slate-50",
              )}
            >
              <p className={clsx("text-sm font-semibold", form.template === t.id ? "text-indigo-700" : "text-slate-900")}>{t.label}</p>
              <p className="text-xs text-slate-500">{t.hint}</p>
            </button>
          ))}
        </div>

        {!editing && (
          /* On-screen preview of exactly what Print produces. Wide paper scrolls sideways on a phone. */
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="min-w-[720px] p-8">{preview}</div>
          </div>
        )}

        {editing && (
          <>
            <div className="grid md:grid-cols-2 gap-5">
              <Card title="From (your company)" icon={<Building2 size={16} className="text-indigo-600" />}>
                <Field label="Business name">
                  <input className={inputCls} value={form.from.name} onChange={(e) => set({ from: { ...form.from, name: e.target.value } })} />
                </Field>
                <Field label="Address">
                  <textarea
                    rows={2}
                    className={inputCls}
                    value={form.from.address}
                    onChange={(e) => set({ from: { ...form.from, address: e.target.value } })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Phone">
                    <input className={inputCls} value={form.from.phone} onChange={(e) => set({ from: { ...form.from, phone: e.target.value } })} />
                  </Field>
                  <Field label="Email">
                    <input className={inputCls} value={form.from.email ?? ""} onChange={(e) => set({ from: { ...form.from, email: e.target.value } })} />
                  </Field>
                </div>
              </Card>

              <Card title="Details" icon={<FileText size={16} className="text-indigo-600" />}>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Invoice #">
                    <p className="mt-1 flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2.5 text-base text-slate-600">
                      <Lock size={13} /> {invoice.invoiceNumber}
                    </p>
                  </Field>
                  <Field label="Date">
                    <input type="date" className={inputCls} value={form.date} onChange={(e) => set({ date: e.target.value })} />
                  </Field>
                  <Field label="Due date">
                    <input type="date" className={inputCls} value={form.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
                  </Field>
                  <Field label="Delivery date">
                    <input type="date" className={inputCls} value={form.deliveryDate} onChange={(e) => set({ deliveryDate: e.target.value })} />
                  </Field>
                  <Field label="P.O. #">
                    <input className={inputCls} value={form.po} onChange={(e) => set({ po: e.target.value })} />
                  </Field>
                </div>
              </Card>

              <Card title="Bill To" icon={<User size={16} className="text-indigo-600" />}>
                <Field label="Customer">
                  <p className="mt-1 flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2.5 text-base text-slate-600">
                    <Lock size={13} /> {invoice.customerName}
                  </p>
                </Field>
                <Field label="Phone">
                  <input className={inputCls} value={form.billTo.phone} onChange={(e) => set({ billTo: { ...form.billTo, phone: e.target.value } })} />
                </Field>
                <Field label="Billing address">
                  <textarea
                    rows={2}
                    className={inputCls}
                    value={form.billTo.address}
                    onChange={(e) =>
                      set({
                        billTo: { ...form.billTo, address: e.target.value },
                      })
                    }
                  />
                </Field>
              </Card>

              <Card title="Ship To" icon={<Truck size={16} className="text-indigo-600" />}>
                <Field label="Recipient name">
                  <input className={inputCls} value={form.shipTo.name} onChange={(e) => set({ shipTo: { ...form.shipTo, name: e.target.value } })} />
                </Field>
                <Field label="Phone">
                  <input className={inputCls} value={form.shipTo.phone} onChange={(e) => set({ shipTo: { ...form.shipTo, phone: e.target.value } })} />
                </Field>
                <Field label="Shipping address">
                  <textarea
                    rows={2}
                    className={inputCls}
                    value={form.shipTo.address}
                    onChange={(e) =>
                      set({
                        shipTo: { ...form.shipTo, address: e.target.value },
                      })
                    }
                  />
                </Field>
              </Card>
            </div>

            <section className="rounded-2xl border border-slate-200 bg-white p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Lock size={15} className="text-slate-400" /> Items (from the invoice, can&apos;t be changed here)
              </h2>
              <div className="mt-3 divide-y divide-slate-100">
                {invoice.items.map((li, idx) => (
                  <div key={idx} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-900">{li.productName}</p>
                      <p className="text-xs text-slate-500">
                        {li.quantity} {li.unit} × {money(li.price)}
                      </p>
                    </div>
                    <p className="text-sm font-medium text-slate-900 shrink-0">{money(li.lineTotal)}</p>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between border-t border-slate-200 pt-2 text-sm font-semibold text-slate-900">
                <span>Total</span>
                <span>{money(invoice.total)}</span>
              </div>
            </section>

            <Card title="Notes & Terms" icon={<StickyNote size={16} className="text-indigo-600" />}>
              <Field label="Notes (printed above the terms)">
                <textarea rows={2} className={inputCls} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
              </Field>
              <Field label="Terms & Conditions (bank details etc. — remembered for next time)">
                <textarea rows={5} className={inputCls} value={form.terms} onChange={(e) => set({ terms: e.target.value })} />
              </Field>
            </Card>
          </>
        )}
      </div>

      <div className="hidden print:block">{preview}</div>
    </>
  );
}
