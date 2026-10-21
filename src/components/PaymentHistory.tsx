"use client";

import { useState } from "react";
import Link from "next/link";
import { changePaymentApi, newOperationId } from "@/lib/businessApi";
import { computePaymentStatus } from "@/lib/invoiceMath";
import { useAppAuth } from "@/lib/useAppAuth";
import PaymentStatusBadge from "@/components/PaymentStatusBadge";
import type { Customer, Invoice, Payment } from "@/lib/types";
import { ArrowRight, X } from "lucide-react";
import { useT } from "@/lib/useLang";

const money = (n: number) => `$${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Customer page "Payment history": every payment and debt adjustment, including cancelled ones (crossed out) and
 * every edit with who/when/why. "Fix" opens the edit/cancel screen. Nothing here is ever deleted.
 */
export default function PaymentHistory({ payments, invoices, customer }: { payments: Payment[]; invoices: Invoice[]; customer: Customer }) {
  const [fixing, setFixing] = useState<Payment | null>(null);
  const t = useT();
  const byId = new Map(invoices.map((i) => [i.id, i]));

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-900">{t("Payment history")}</h2>
      {payments.length === 0 && <p className="text-sm text-slate-400 py-4 text-center">{t("No payments yet.")}</p>}
      {payments.map((p) => {
        const inv = p.invoiceId ? byId.get(p.invoiceId) : undefined;
        return (
          <div key={p.id} className={`rounded-2xl border bg-white p-4 ${p.cancelled ? "border-slate-200 opacity-70" : "border-slate-200"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className={`font-semibold ${p.cancelled ? "line-through text-slate-400" : p.kind === "adjustment" ? "text-amber-700" : "text-emerald-700"}`}>
                    {p.kind === "adjustment" ? "−" : ""}
                    {money(p.amount)}
                  </span>
                  <span className="text-slate-500">→</span>
                  {inv ? (
                    <Link href={`/invoices/${inv.id}?back=${encodeURIComponent(`/customers/${customer.id}`)}`} className="font-medium text-indigo-600">
                      #{inv.invoiceNumber}
                    </Link>
                  ) : (
                    <span className="font-medium text-sky-700">{p.unallocated ? t("Credit") : t("Invoice")}</span>
                  )}
                  {p.kind === "adjustment" && <Tag cls="bg-amber-100 text-amber-800">{t("Adjustment")}</Tag>}
                  {p.cancelled && <Tag cls="bg-red-100 text-red-700">{t("Cancelled")}</Tag>}
                  {!p.cancelled && (p.history?.length ?? 0) > 0 && <Tag cls="bg-indigo-100 text-indigo-700">{t("Edited")}</Tag>}
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  {new Date(p.paidAt ?? p.createdAt).toLocaleDateString()}
                  {p.paidAt && new Date(p.paidAt).toDateString() !== new Date(p.createdAt).toDateString() ? ` (${t("entered {date}", { date: new Date(p.createdAt).toLocaleDateString() })})` : ""}
                  {p.method ? ` · ${t(p.method)}` : ""}
                  {p.by ? ` · ${p.by}` : ""}
                </p>
                {p.reason && <p className="text-xs text-slate-600 mt-0.5">{t("Reason:")} {p.reason}</p>}
                {p.note && <p className="text-xs text-slate-600 mt-0.5">{t("Note:")} {p.note}</p>}
              </div>
              {!p.cancelled && (
                <button onClick={() => setFixing(p)} className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                  {t("Fix")}
                </button>
              )}
            </div>
            {(p.history ?? []).map((h, i) => (
              <p key={i} className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
                {h.action === "cancel" ? t("Cancelled (was {amount})", { amount: money(h.amountBefore) }) : t("Changed {before} → {after}", { before: money(h.amountBefore), after: money(h.amountAfter) })} · {new Date(h.at).toLocaleString()}
                {h.by ? ` · ${h.by}` : ""} · {t("Reason:")} {h.reason}
              </p>
            ))}
          </div>
        );
      })}
      {fixing && <FixPaymentModal payment={fixing} invoice={fixing.invoiceId ? byId.get(fixing.invoiceId) : undefined} customer={customer} onClose={() => setFixing(null)} />}
    </div>
  );
}

function Tag({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

/**
 * Edit the amount of a payment entered wrong, or cancel it. Shows the invoice's balance and tag before → after
 * (or the customer's credit) and needs a reason plus a second Confirm tap. The server re-checks everything.
 */
function FixPaymentModal({ payment, invoice, customer, onClose }: { payment: Payment; invoice?: Invoice; customer: Customer; onClose: () => void }) {
  const { authedFetch } = useAppAuth();
  const t = useT();
  const [action, setAction] = useState<"edit" | "cancel">("edit");
  const [amount, setAmount] = useState(String(payment.amount));
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [operationId] = useState(newOperationId);

  const newAmount = action === "cancel" ? 0 : round2(Number(amount));
  const amountOk = action === "cancel" || (amount !== "" && Number.isFinite(newAmount) && newAmount > 0 && newAmount !== payment.amount);
  const delta = round2(newAmount - payment.amount);

  let problem = "";
  let preview: React.ReactNode = null;
  if (amountOk && invoice) {
    const paid = round2(invoice.amountPaid + delta);
    const balance = round2(invoice.total - paid);
    if (delta > 0 && paid > invoice.total) problem = t("That would pay invoice #{n} more than its total ({amount}).", { n: invoice.invoiceNumber, amount: money(invoice.total) });
    preview = (
      <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
        <p className="text-xs text-slate-500 mb-1">{t("Invoice #{n} (total {amount})", { n: invoice.invoiceNumber, amount: money(invoice.total) })}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span>{t("Owes {amount}", { amount: money(invoice.balance) })}</span>
          <PaymentStatusBadge status={invoice.paymentStatus} />
          <ArrowRight size={14} className="text-slate-400" />
          <span className="font-semibold">{t("Owes {amount}", { amount: money(balance) })}</span>
          <PaymentStatusBadge status={computePaymentStatus(invoice.total, paid, invoice.paymentStatus)} />
        </div>
      </div>
    );
  } else if (amountOk && !payment.invoiceId) {
    const before = customer.credit ?? 0;
    const after = round2(before + delta);
    if (after < 0) problem = t("{name} only has {amount} credit left.", { name: customer.name, amount: money(before) });
    preview = (
      <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
        {t("Customer credit")} {money(before)} <ArrowRight size={14} className="inline text-slate-400" /> <span className="font-semibold">{money(after)}</span>
      </div>
    );
  }
  const valid = amountOk && !problem && reason.trim() !== "";

  async function submit() {
    if (!valid) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await changePaymentApi(authedFetch, payment.id, { action, ...(action === "edit" ? { amount: newAmount } : {}), reason: reason.trim() }, operationId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? t(e.message) : t("Failed to change the payment."));
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  }

  const reset = () => setConfirming(false);

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30">
      <div className="w-full md:max-w-md max-h-[90vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{payment.kind === "adjustment" ? t("Fix adjustment") : t("Fix payment")}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {t("{amount} on {date}", { amount: money(payment.amount), date: new Date(payment.createdAt).toLocaleDateString() })}
              {invoice ? ` → #${invoice.invoiceNumber}` : payment.unallocated ? ` → ${t("credit")}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label={t("Close")}>
            <X size={18} />
          </button>
        </div>

        <div className="flex rounded-xl border border-slate-200 p-1 text-sm font-medium mb-3">
          {(["edit", "cancel"] as const).map((a) => (
            <button
              key={a}
              onClick={() => {
                setAction(a);
                reset();
              }}
              className={`flex-1 rounded-lg px-3 py-2 ${action === a ? (a === "cancel" ? "bg-red-600 text-white" : "bg-slate-900 text-white") : "text-slate-600"}`}
            >
              {a === "edit" ? t("Change amount") : t("Cancel it")}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          {action === "edit" && (
            <div>
              <label className="text-xs font-medium text-slate-600">{t("Correct amount")}</label>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  reset();
                }}
              />
            </div>
          )}
          {action === "cancel" && <p className="text-sm text-slate-600">{t("The payment stays in the history, crossed out. Its money goes back onto what is owed.")}</p>}
          <div>
            <label className="text-xs font-medium text-slate-600">{t("Reason (required)")}</label>
            <input
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                reset();
              }}
              placeholder={t("e.g. typed 500 instead of 50")}
            />
          </div>
          {preview}
          {problem && <p className="text-sm text-red-600">{problem}</p>}
          {confirming && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{t("Check the before → after above, then tap Confirm.")}</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
            {t("Close")}
          </button>
          <button
            onClick={submit}
            disabled={saving || !valid}
            className={`rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 ${action === "cancel" ? "bg-red-600 hover:bg-red-700" : "bg-indigo-600 hover:bg-indigo-700"}`}
          >
            {saving ? t("Saving…") : confirming ? (action === "cancel" ? t("Confirm cancel") : t("Confirm change")) : t("Review")}
          </button>
        </div>
      </div>
    </div>
  );
}
