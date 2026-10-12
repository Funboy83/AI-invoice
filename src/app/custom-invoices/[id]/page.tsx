"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Printer, CalendarDays } from "lucide-react";
import { watchInvoiceLogs } from "@/lib/store";
import { formatDateKey, getCustomInvoiceApi, getCustomInvoiceSettingsApi, updateCustomInvoiceDateApi } from "@/lib/businessApi";
import { useActionId } from "@/lib/useActionId";
import { useAppAuth, isPermissionDenied } from "@/lib/useAppAuth";
import type { CustomInvoice, InvoiceLog } from "@/lib/types";
import CustomInvoicePrint from "@/components/CustomInvoicePrint";

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CustomInvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { authedFetch, notifyPossibleRevocation } = useAppAuth();
  const [ci, setCi] = useState<CustomInvoice | null>(null);
  const [loadError, setLoadError] = useState("");
  const [settings, setSettings] = useState<{ header: string; terms: string }>({ header: "", terms: "" });
  const [logs, setLogs] = useState<InvoiceLog[]>([]);

  const [editingDate, setEditingDate] = useState(false);
  const [draftDate, setDraftDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dateAction = useActionId();

  const load = useCallback(async () => {
    try {
      const [inv, s] = await Promise.all([getCustomInvoiceApi(authedFetch, id), getCustomInvoiceSettingsApi(authedFetch)]);
      setCi(inv);
      setSettings(s);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this custom invoice.");
    }
  }, [authedFetch, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async load, not a derived-state anti-pattern
    load();
    return watchInvoiceLogs(id, setLogs, (err) => isPermissionDenied(err) && notifyPossibleRevocation());
  }, [id, load, notifyPossibleRevocation]);

  async function saveDate() {
    if (!ci || !draftDate) return;
    setSaving(true);
    setError("");
    try {
      setCi(await updateCustomInvoiceDateApi(authedFetch, ci.id, draftDate, dateAction.current()));
      setEditingDate(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change the date.");
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <div className="p-8 text-slate-400 text-sm">{loadError}</div>;
  if (!ci) return <div className="p-8 text-slate-400 text-sm">Loading…</div>;

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6 pb-24 md:pb-8 print:p-0 print:max-w-none">
      <div className="flex items-center justify-between print:hidden">
        <button onClick={() => router.push("/custom-invoices")} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft size={15} /> Back
        </button>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <Printer size={14} /> Print / PDF
        </button>
      </div>

      {/* Screen summary — read-only except the date. */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 print:hidden">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Custom Invoice #{ci.invoiceNumber}</h1>
            <p className="text-sm text-slate-500 mt-1">{ci.customerName}</p>
            <p className="text-xs text-slate-400 mt-1">
              Copy of{" "}
              <Link href={`/invoices/${ci.sourceInvoiceId}`} className="text-indigo-600 hover:underline">
                invoice #{ci.sourceInvoiceNumber}
              </Link>
            </p>
          </div>
          <p className="text-lg font-semibold text-slate-900">{money(ci.total)}</p>
        </div>

        <div className="mt-5 rounded-xl border border-slate-200 p-3">
          {!editingDate ? (
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm text-slate-700">
                <CalendarDays size={16} className="text-slate-400" /> Date: <span className="font-medium">{formatDateKey(ci.date)}</span>
              </p>
              <button
                onClick={() => {
                  setDraftDate(ci.date);
                  setError("");
                  dateAction.start();
                  setEditingDate(true);
                }}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Change date
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="text-xs font-medium text-slate-600">New date</label>
              <input
                type="date"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
                value={draftDate}
                onChange={(e) => setDraftDate(e.target.value)}
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditingDate(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100">
                  Cancel
                </button>
                <button
                  onClick={saveDate}
                  disabled={saving || !draftDate}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save date"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-5 space-y-2">
          {ci.items.map((li, idx) => (
            <div key={idx} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{li.productName}</p>
                <p className="text-xs text-slate-500">
                  {li.quantity} {li.unit} × {money(li.price)}
                </p>
              </div>
              <p className="text-sm font-semibold text-slate-900 shrink-0">{money(li.lineTotal)}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-slate-400">
          Customer, items and prices are locked to the copied invoice. This copy does not change the customer&apos;s debt or stock.
        </p>
      </div>

      {logs.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 print:hidden">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">History</h2>
          <div className="space-y-2">
            {logs.map((log) => (
              <div key={log.id} className="text-sm">
                <p className="text-slate-700">{log.message}</p>
                <p className="text-xs text-slate-400">{new Date(log.timestamp).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <CustomInvoicePrint invoice={ci} header={settings.header} terms={settings.terms} />
    </div>
  );
}
