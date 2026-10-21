"use client";

import { useMemo, useState } from "react";
import { newOperationId, recordCustomerPaymentApi, toDateKey, type CustomerPaymentResponse } from "@/lib/businessApi";
import { allocatePaymentOldestFirst, compareOldestFirst } from "@/lib/paymentAllocation";
import { computePaymentStatus } from "@/lib/invoiceMath";
import { useAppAuth } from "@/lib/useAppAuth";
import PaymentStatusBadge from "@/components/PaymentStatusBadge";
import type { Customer, Invoice } from "@/lib/types";
import { X } from "lucide-react";
import { useT } from "@/lib/useLang";

export const PAYMENT_METHODS = ["Cash", "Check", "Zelle", "Card", "Bank transfer", "Other"] as const;

const money = (n: number) => `$${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A picked "YYYY-MM-DD": today → right now; another day → noon local time that day (safe from time-zone edges). */
function paidAtFor(dateKey: string): number {
  if (dateKey === toDateKey()) return Date.now();
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

/**
 * Customer page "Record payment" / "Adjust debt", laid out like KiotViet's "Thanh toán" popup: date, method,
 * amount (with debt left), note, and a read-only "Applied to invoices" table that lists every open invoice oldest
 * first and fills the Applied column automatically as the amount is typed. The table uses the same split the server
 * uses; the server re-reads every invoice and does the real split, and the saved result is shown after saving.
 * Render only while open: each mount is one payment, so its operationId stays the same across retries of THIS
 * payment (a lost-response retry can't pay twice) and is fresh for the next one.
 */
export default function CustomerPaymentModal({
  customer,
  invoices: liveInvoices,
  totalOwed: liveTotalOwed,
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
  // Snapshot at open: the page's live data changes the moment the payment saves, and the table must keep showing
  // the "before" numbers next to what was applied.
  const [invoices] = useState(liveInvoices);
  const [totalOwed] = useState(liveTotalOwed);
  const { authedFetch } = useAppAuth();
  const t = useT();
  const [date, setDate] = useState(() => toDateKey());
  const [method, setMethod] = useState<string>("Cash");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<CustomerPaymentResponse | null>(null);
  const [operationId] = useState(newOperationId);

  const open = useMemo(() => invoices.filter((i) => (i.paymentStatus === "unpaid" || i.paymentStatus === "partial") && i.balance > 0).sort(compareOldestFirst), [invoices]);
  const value = Number(amount);
  const hasAmount = amount !== "" && Number.isFinite(value) && value > 0;
  const split = useMemo(() => allocatePaymentOldestFirst(open, hasAmount ? value : 0), [open, hasAmount, value]);
  const applied = new Map((saved ?? split).allocations.map((a) => [a.invoiceId, a.amount]));
  const leftover = saved ? saved.leftover : hasAmount ? split.leftover : 0;
  const appliedTotal = round2([...applied.values()].reduce((s, n) => s + n, 0));
  const debtLeft = round2(totalOwed - appliedTotal);
  const tooMuch = adjusting && leftover > 0;
  const valid = hasAmount && !tooMuch && (!adjusting || reason.trim() !== "") && date !== "" && date <= toDateKey();

  const touch = () => setConfirming(false);

  async function submit() {
    if (!valid) return;
    if (adjusting && !confirming) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const paidAt = paidAtFor(date);
      setSaved(
        await recordCustomerPaymentApi(
          authedFetch,
          customer.id,
          adjusting
            ? { amount: value, kind: "adjustment", reason: reason.trim(), paidAt }
            : { amount: value, method, note: note.trim() || undefined, paidAt },
          operationId
        )
      );
    } catch (e) {
      setError(e instanceof Error ? t(e.message) : t("Failed to record payment."));
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  }

  const input = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base disabled:bg-slate-50 disabled:text-slate-500";

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30">
      <div className="w-full md:max-w-3xl max-h-[95vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-white p-5 md:p-6 shadow-xl">
        {/* Header: who and how much they owe right now */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              {saved ? (adjusting ? t("Debt adjusted") : t("Payment saved")) : adjusting ? t("Adjust debt") : t("Record payment")}
            </h2>
            <p className="text-sm text-slate-600 mt-0.5">{customer.name}</p>
          </div>
          <div className="flex items-start gap-3">
            <div className="text-right">
              <p className="text-xs uppercase text-slate-500">{t("Current debt")}</p>
              <p className="text-xl font-semibold text-amber-700">{money(totalOwed)}</p>
            </div>
            <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label={t("Close")}>
              <X size={20} />
            </button>
          </div>
        </div>

        {adjusting && !saved && (
          <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t(
              "Lowers what {name} owes without counting it as money received (for example a small amount you forgive). It is logged with your reason. To fix a payment entered wrong, use Fix on that payment in Payment history instead.",
              { name: customer.name }
            )}
          </p>
        )}

        {/* Form */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
          <div>
            <label className="text-xs font-medium text-slate-600">{t("Date")}</label>
            <input
              type="date"
              className={input}
              value={date}
              max={toDateKey()}
              disabled={!!saved}
              onChange={(e) => {
                setDate(e.target.value);
                touch();
              }}
            />
          </div>
          {adjusting ? (
            <div>
              <label className="text-xs font-medium text-slate-600">{t("Reason (required)")}</label>
              <input
                className={input}
                value={reason}
                disabled={!!saved}
                onChange={(e) => {
                  setReason(e.target.value);
                  touch();
                }}
                placeholder={t("e.g. forgave rounding, damaged item")}
              />
            </div>
          ) : (
            <div>
              <label className="text-xs font-medium text-slate-600">{t("Payment method")}</label>
              <select className={input} value={method} disabled={!!saved} onChange={(e) => setMethod(e.target.value)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(m)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-slate-600">{adjusting ? t("Lower the debt by") : t("Amount received")}</label>
            <div className="mt-1 flex gap-2">
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                autoFocus
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-lg font-semibold disabled:bg-slate-50"
                value={amount}
                disabled={!!saved}
                onChange={(e) => {
                  setAmount(e.target.value);
                  touch();
                }}
                placeholder="0.00"
              />
              {totalOwed > 0 && !saved && (
                <button
                  type="button"
                  onClick={() => {
                    setAmount(totalOwed.toFixed(2));
                    touch();
                  }}
                  className="shrink-0 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  {adjusting ? t("All") : t("Pay all")}
                </button>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-600">
              {t("Debt left:")} <span className={`font-semibold ${debtLeft > 0 ? "text-amber-700" : "text-emerald-700"}`}>{money(Math.max(0, debtLeft))}</span>
            </p>
          </div>
          {!adjusting && (
            <div>
              <label className="text-xs font-medium text-slate-600">{t("Note (optional)")}</label>
              <input className={input} value={note} disabled={!!saved} onChange={(e) => setNote(e.target.value)} placeholder={t("e.g. check #1234")} />
            </div>
          )}
        </div>

        {/* Read-only allocation table: every open invoice, oldest first; Applied fills in as the amount is typed */}
        <div className="mt-5">
          <p className="text-sm font-semibold text-slate-900 mb-2">{t("Applied to invoices (oldest first)")}</p>
          {open.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-500">{t("No unpaid invoices. The whole amount will be kept as customer credit.")}</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t("Invoice")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("Date")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("Total")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("Paid before")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("Still owed")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("Applied")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("After")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {open.map((inv) => {
                    const a = applied.get(inv.id) ?? 0;
                    const paidAfter = round2(inv.amountPaid + a);
                    return (
                      <tr key={inv.id} className={a > 0 ? "bg-emerald-50/50" : ""}>
                        <td className="px-3 py-2 font-medium text-slate-900">#{inv.invoiceNumber}</td>
                        <td className="px-3 py-2 text-slate-600">{new Date(inv.date).toLocaleDateString()}</td>
                        <td className="px-3 py-2 text-right text-slate-700">{money(inv.total)}</td>
                        <td className="px-3 py-2 text-right text-slate-700">{money(inv.amountPaid)}</td>
                        <td className="px-3 py-2 text-right text-slate-700">{money(inv.balance)}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${a > 0 ? "text-emerald-700" : "text-slate-300"}`}>{money(a)}</td>
                        <td className="px-3 py-2">
                          <PaymentStatusBadge status={computePaymentStatus(inv.total, paidAfter, inv.paymentStatus)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-50 text-sm">
                  <tr>
                    <td colSpan={4} className="px-3 py-2 font-medium text-slate-700">
                      {t("Total")}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-slate-700">{money(totalOwed)}</td>
                    <td className="px-3 py-2 text-right font-semibold text-emerald-700">{money(appliedTotal)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {leftover > 0 && !adjusting && (
            <p className="mt-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
              {t("Not applied:")} <span className="font-semibold">{money(leftover)}</span> {saved ? t("was kept as customer credit.") : t("will be kept as customer credit.")}
            </p>
          )}
        </div>

        {tooMuch && !saved && <p className="mt-3 text-sm text-red-600">{t("That is more than {name} owes ({amount}).", { name: customer.name, amount: money(totalOwed) })}</p>}
        {confirming && !saved && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{t("Check the table above, then tap Confirm to save this adjustment.")}</p>
        )}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          {saved ? (
            <button onClick={onClose} className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white">
              {t("Done")}
            </button>
          ) : (
            <>
              <button onClick={onClose} className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
                {t("Cancel")}
              </button>
              <button
                onClick={submit}
                disabled={saving || !valid}
                className={`rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50 ${adjusting ? "bg-amber-600 hover:bg-amber-700" : "bg-emerald-600 hover:bg-emerald-700"}`}
              >
                {saving ? t("Saving…") : adjusting ? (confirming ? t("Confirm −{amount}", { amount: money(value) }) : t("Review")) : hasAmount ? t("Save payment {amount}", { amount: money(value) }) : t("Save payment")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
