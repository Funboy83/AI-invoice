"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, X, FileText } from "lucide-react";
import { watchInvoices } from "@/lib/store";
import { createCustomInvoiceApi, formatDateKey, listCustomInvoicesApi, toDateKey } from "@/lib/businessApi";
import { useActionId } from "@/lib/useActionId";
import { useAppAuth, isPermissionDenied } from "@/lib/useAppAuth";
import { isCommittedStatus, type CustomInvoice, type Invoice } from "@/lib/types";
import SearchCombobox from "@/components/SearchCombobox";

// useSearchParams (?from=<invoiceId>, opened from an invoice's page) needs a Suspense boundary to build.
export default function CustomInvoicesPage() {
  return (
    <Suspense fallback={null}>
      <CustomInvoicesPageContent />
    </Suspense>
  );
}

function CustomInvoicesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { authedFetch, notifyPossibleRevocation } = useAppAuth();
  const [customInvoices, setCustomInvoices] = useState<CustomInvoice[] | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [listError, setListError] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<Invoice | null>(null);
  const [date, setDate] = useState(toDateKey());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const createAction = useActionId();

  const load = useCallback(async () => {
    try {
      setCustomInvoices(await listCustomInvoicesApi(authedFetch));
      setListError("");
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Could not load custom invoices.");
    }
  }, [authedFetch]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async load, not a derived-state anti-pattern
    load();
    return watchInvoices(setInvoices, (err) => isPermissionDenied(err) && notifyPossibleRevocation());
  }, [load, notifyPossibleRevocation]);

  // Only finished invoices can be copied — never a draft (may be incomplete) or a voided one.
  const sources = invoices.filter((i) => isCommittedStatus(i.paymentStatus));

  function pick(inv: Invoice) {
    setSource(inv);
    setQuery(`#${inv.invoiceNumber} ${inv.customerName}`);
    setDate(toDateKey(inv.date));
  }

  function openModal(from?: Invoice) {
    setQuery("");
    setSource(null);
    setDate(toDateKey());
    setError("");
    createAction.start();
    if (from) pick(from);
    setModalOpen(true);
  }

  // Opened from an invoice's "Custom Invoice" button: /custom-invoices?from=<invoiceId> starts with it picked.
  const fromId = searchParams.get("from");
  useEffect(() => {
    if (!fromId) return;
    const inv = invoices.find((i) => i.id === fromId);
    if (!inv) return;
    router.replace("/custom-invoices");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time open driven by the URL
    openModal(isCommittedStatus(inv.paymentStatus) ? inv : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromId, invoices]);

  async function handleCreate() {
    setError("");
    if (!source) return setError("Pick the invoice to copy first.");
    if (!date) return setError("Pick a date.");
    setSaving(true);
    try {
      const created = await createCustomInvoiceApi(authedFetch, source.id, date, createAction.current());
      setModalOpen(false);
      router.push(`/custom-invoices/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create the custom invoice.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 pb-24 md:pb-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Custom Invoice</h1>
          <p className="text-sm text-slate-500 mt-1 hidden md:block">
            A copy of an invoice with its own number and the business print layout. Only the date can be changed.
          </p>
        </div>
        <button
          onClick={() => openModal()}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={16} /> New
        </button>
      </div>

      {listError && <p className="text-sm text-red-600">{listError}</p>}
      {customInvoices === null && !listError && <p className="text-sm text-slate-400">Loading…</p>}

      {customInvoices && (
        <div className="rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
          {customInvoices.map((ci) => (
            <Link key={ci.id} href={`/custom-invoices/${ci.id}`} className="flex items-center justify-between gap-3 px-4 md:px-5 py-3.5 hover:bg-slate-50 active:bg-slate-50">
              <div className="min-w-0">
                <p className="font-medium text-slate-900 truncate">
                  #{ci.invoiceNumber} · {ci.customerName}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {formatDateKey(ci.date)} · copy of #{ci.sourceInvoiceNumber}
                </p>
              </div>
              <p className="text-sm font-semibold text-slate-900 shrink-0">${ci.total.toFixed(2)}</p>
            </Link>
          ))}
          {customInvoices.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-slate-400">
              <FileText size={22} className="mx-auto mb-2 opacity-50" />
              No custom invoices yet. Tap New and pick the invoice to copy.
            </div>
          )}
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30">
          <div className="w-full md:max-w-lg rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-900">New custom invoice</h2>
              <button onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-slate-700">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-600">Copy from invoice</label>
                <SearchCombobox
                  items={sources}
                  getId={(i) => i.id}
                  getLabel={(i) => `#${i.invoiceNumber} ${i.customerName}`}
                  getSubLabel={(i) => `${new Date(i.date).toLocaleDateString()} · $${i.total.toFixed(2)}`}
                  value={query}
                  onQueryChange={(q) => {
                    setQuery(q);
                    setSource(null);
                  }}
                  onSelect={pick}
                  placeholder="Tìm số hóa đơn hoặc tên khách..."
                />
              </div>
              {source && (
                <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
                  <p>
                    {source.items.length} item{source.items.length === 1 ? "" : "s"} · total <span className="font-semibold text-slate-900">${source.total.toFixed(2)}</span>
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">Customer, items and prices are copied as they are and cannot be edited.</p>
                </div>
              )}
              <div>
                <label className="text-xs font-medium text-slate-600">Date</label>
                <input
                  type="date"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <p className="text-xs text-slate-500">It gets the next invoice number automatically.</p>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setModalOpen(false)} className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={saving}
                className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
