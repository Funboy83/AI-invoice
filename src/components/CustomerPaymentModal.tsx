"use client";

import { useMemo, useState } from "react";
import { newOperationId, recordCustomerPaymentApi, type CustomerPaymentResponse } from "@/lib/businessApi";
import { allocatePaymentOldestFirst } from "@/lib/paymentAllocation";
import { useAppAuth } from "@/lib/useAppAuth";
import PaymentStatusBadge from "@/components/PaymentStatusBadge";
import type { Customer, Invoice } from "@/lib/types";
import { X } from "lucide-react";

/**
 * Customer page "Record payment": one amount, applied to the customer's open invoices OLDEST first (KiotViet's
 * "Phân bổ vào hóa đơn"). The list under the amount is a live preview using the same split the server uses; the
 * server re-reads every invoice and does the real split, so the saved result is always the authoritative one and
 * is shown after saving. Render only while open: each mount is one payment, so its operationId stays the same
 * across retries of THIS payment (a lost-response retry can't pay twice) and is fresh for the next one.
 */
export default function CustomerPaymentModal({
  customer,
  invoices,
  totalOwed,
  mode = "payment",
  onClose,
}: {
  customer: Customer;
  invoices: Invoice[];
  totalOwed: number;
  /** "adjustment": lower the debt by hand (not money received) — reason required, never more than owed, confirm tap. */
  mode?: "payment" | "adjustment";
  onClose: () => void;
}) {
  const adjusting = mode === "adjustment";
  const { authedFetch } = useAppAuth();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<CustomerPaymentResponse | null>(null);
  const [operationId] = useState(newOperationId);

  const value = Number(amount);
  const preview = useMemo(() => (amount !== "" && Number.isFinite(value) && value > 0 ? allocatePaymentOldestFirst(invoices, value) : null), [amount, invoices, value]);
  const tooMuch = adjusting && !!preview && preview.leftover > 0;
  const valid = !!preview && !tooMuch && (!adjusting || reason.trim() !== "");

  async function submit() {
    if (!valid) return;
    if (adjusting && !confirming) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    setError("");
    try {
      setSaved(await recordCustomerPaymentApi(authedFetch, customer.id, adjusting
          ? { amount: value, kind: "adjustment", reason: reason.trim() }
          : { amount: value, method: method.trim() || undefined, note: note.trim() || undefined }, operationId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record payment.");
    } finally {
      setSaving(false);
    }
  }

  const result = saved ?? preview;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30">
      <div className="w-full md:max-w-md max-h-[90vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{saved ? (adjusting ? "Debt adjusted" : "Payment saved") : adjusting ? "Adjust debt" : "Record payment"}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {customer.name} · owes ${totalOwed.toFixed(2)}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {!saved && adjusting && (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Lowers what {customer.name} owes without counting it as money received (for example a small amount you forgive). It is logged with
            your reason. To fix a payment entered wrong, use Fix on that payment in Payment history instead.
          </p>
        )}

        {!saved && (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-slate-600">{adjusting ? "Lower the debt by" : "Amount received"}</label>
              <div className="mt-1 flex gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  autoFocus
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-base"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setConfirming(false);
                  }}
                  placeholder="0.00"
                />
                {totalOwed > 0 && !adjusting && (
                  <button
                    type="button"
                    onClick={() => setAmount(totalOwed.toFixed(2))}
                    className="shrink-0 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Pay all
                  </button>
                )}
              </div>
            </div>
            {adjusting ? (
              <div>
                <label className="text-xs font-medium text-slate-600">Reason (required)</label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setConfirming(false);
                  }}
                  placeholder="e.g. forgave rounding, damaged item"
                />
              </div>
            ) : (
              <>
            <div>
              <label className="text-xs font-medium text-slate-600">Method (optional)</label>
              <input
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                placeholder="cash, zelle, check…"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600">Note (optional)</label>
              <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
              </>
            )}
          </div>
        )}

        {result && (
          <div className="mt-4">
            <p className="text-xs font-medium uppercase text-slate-500 mb-2">{saved ? "Applied to invoices (oldest first)" : "Will be applied oldest invoice first"}</p>
            <div className="space-y-1.5">
              {result.allocations.map((a) => (
                <div key={a.invoiceId} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-slate-900">#{a.invoiceNumber}</span>
                    <PaymentStatusBadge status={a.balanceAfter > 0 ? "partial" : "paid"} />
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-emerald-700">−${a.amount.toFixed(2)}</p>
                    {a.balanceAfter > 0 && <p className="text-xs text-amber-700">still owes ${a.balanceAfter.toFixed(2)}</p>}
                  </div>
                </div>
              ))}
              {result.allocations.length === 0 && <p className="text-sm text-slate-500">No unpaid invoices to apply this to.</p>}
              {result.leftover > 0 && (
                <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
                  <span className="font-semibold">${result.leftover.toFixed(2)}</span> extra {saved ? "was" : "will be"} kept as customer credit.
                </div>
              )}
            </div>
          </div>
        )}

        {tooMuch && !saved && <p className="mt-3 text-sm text-red-600">That is more than {customer.name} owes (${totalOwed.toFixed(2)}).</p>}
        {confirming && !saved && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">Check the list above, then tap Confirm to save this adjustment.</p>
        )}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          {saved ? (
            <button onClick={onClose} className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white">
              Done
            </button>
          ) : (
            <>
              <button onClick={onClose} className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={saving || !valid}
                className={`rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 ${adjusting ? "bg-amber-600 hover:bg-amber-700" : "bg-emerald-600 hover:bg-emerald-700"}`}
              >
                {saving ? "Saving…" : adjusting ? (confirming ? `Confirm −$${value.toFixed(2)}` : "Review") : valid ? `Record $${value.toFixed(2)}` : "Record"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
