"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { newOperationId } from "@/lib/businessApi";
import {
  formatDateKey,
  getPurchaseApi,
  money,
  purchaseStatusLabel,
  purchaseStatusStyles,
  recordVendorPaymentApi,
  updatePurchaseInfoApi,
  voidPurchaseApi,
} from "@/lib/purchaseApi";
import { useAppAuth } from "@/lib/useAppAuth";
import { printPage } from "@/lib/printPage";
import { purchaseOwed, type Purchase, type VendorPayment } from "@/lib/types";
import { ArrowLeft, Ban, CheckCircle2, DollarSign, Pencil, Printer, X } from "lucide-react";
import { useT } from "@/lib/useLang";

const COMPANY_NAME = process.env.NEXT_PUBLIC_COMPANY_NAME || "Ngan";

// useSearchParams (?saved=1 right after saving) needs a Suspense boundary to build.
export default function PurchaseDetailPage() {
  return (
    <Suspense fallback={null}>
      <PurchaseDetail />
    </Suspense>
  );
}

/** One purchase: what was bought, what is owed, payments, and actions (pay, edit details, cancel, print). */
function PurchaseDetail() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const justSaved = params.get("saved") === "1";
  const savedNotes = params.getAll("note");
  const { authedFetch } = useAppAuth();
  const t = useT();
  const [purchase, setPurchase] = useState<Purchase | null>(null);
  const [payments, setPayments] = useState<VendorPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<string[]>([]);
  const [dialog, setDialog] = useState<"pay" | "edit" | "void" | null>(null);

  // Bump `reloadTick` to fetch again after a change (save, payment, cancel).
  const [reloadTick, setReloadTick] = useState(0);
  const load = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getPurchaseApi(authedFetch, id);
        if (cancelled) return;
        setPurchase(data.purchase);
        setPayments(data.payments);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load this purchase.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authedFetch, id, reloadTick]);

  if (loading) return <div className="p-8 text-center text-sm text-slate-400">{t("Loading…")}</div>;
  if (!purchase) {
    return (
      <div className="p-8 text-center text-sm text-slate-500 space-y-3">
        <p>{error ? t(error) : t("This purchase was not found.")}</p>
        <Link href="/purchases" className="text-indigo-600">
          {t("Back to purchases")}
        </Link>
      </div>
    );
  }

  const p = purchase;
  const isVoid = p.paymentStatus === "void";
  const owed = purchaseOwed(p);
  const btn = "flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50";

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-5 pb-24 md:pb-8 print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href="/purchases" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft size={15} /> {t("Purchases")}
        </Link>
        <div className="flex flex-wrap justify-end gap-2">
          <button onClick={() => void printPage()} className={btn}>
            <Printer size={14} /> {t("Print / PDF")}
          </button>
          {owed > 0 && (
            <button onClick={() => setDialog("pay")} className={btn}>
              <DollarSign size={14} /> {t("Pay vendor")}
            </button>
          )}
          {!isVoid && (
            <button onClick={() => setDialog("edit")} className={btn}>
              <Pencil size={14} /> {t("Edit details")}
            </button>
          )}
          {!isVoid && (
            <button onClick={() => setDialog("void")} className={`${btn} text-red-600`}>
              <Ban size={14} /> {t("Cancel purchase")}
            </button>
          )}
        </div>
      </div>

      {justSaved && (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 print:hidden">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <div>
            <p>{t("Saved. The quantities were added to your stock.")}</p>
            {savedNotes.map((n) => (
              <p key={n} className="text-xs mt-0.5">{n}</p>
            ))}
          </div>
        </div>
      )}
      {notice.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 print:hidden">
          {notice.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
      {error && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 print:hidden">{t(error)}</p>}

      {/* Screen view */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6 print:hidden">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-900">{p.purchaseNumber}</h1>
              <span className={`text-[10px] uppercase font-medium px-2 py-0.5 rounded-full ${purchaseStatusStyles[p.paymentStatus]}`}>{t(purchaseStatusLabel[p.paymentStatus])}</span>
            </div>
            <p className="text-sm text-slate-600 mt-1">
              {t("From")}{" "}
              <Link href={`/vendors/${p.vendorId}`} className="font-medium text-indigo-600">
                {p.vendorName}
              </Link>{" "}
              · {formatDateKey(p.dateKey)}
            </p>
            <p className="text-sm text-slate-600 mt-0.5">{t("Vendor invoice #:")} {p.vendorInvoiceNumber ? <span className="font-medium text-slate-900">{p.vendorInvoiceNumber}</span> : <span className="text-slate-400">{t("not entered")}</span>}</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase text-slate-500">{t("Total")}</p>
            <p className={`text-2xl font-semibold ${isVoid ? "text-slate-400 line-through" : "text-slate-900"}`}>{money(p.total)}</p>
            {owed > 0 && <p className="text-sm font-medium text-rose-700">{t("I owe {amount}", { amount: money(owed) })}</p>}
          </div>
        </div>
        {isVoid && <p className="mt-3 rounded-lg bg-red-50 p-2 text-sm text-red-700">{t("Cancelled. Its stock was taken back out and it no longer counts as owed.")}</p>}

        <div className="mt-5 divide-y divide-slate-100 border-t border-slate-100">
          {p.items.map((li, i) => (
            <div key={i} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-slate-900">{li.productName}</p>
                <p className="text-xs text-slate-500">
                  {li.quantity} {li.unit} × {money(li.cost)}
                </p>
              </div>
              <p className="font-medium text-slate-900">{money(li.lineTotal)}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm">
          <Row label="Subtotal" value={money(p.subtotal)} />
          {p.shipping > 0 && <Row label="Shipping / fees" value={money(p.shipping)} />}
          {p.discount > 0 && <Row label="Discount" value={`-${money(p.discount)}`} />}
          <Row label="Total" value={money(p.total)} bold />
          <Row label="Paid" value={money(p.amountPaid)} />
          {!isVoid && <Row label="Still owed" value={money(p.balance)} />}
        </div>
        {p.updatedCost && <p className="mt-3 text-xs text-slate-500">{t("Product costs were updated to these prices.")}</p>}
        {p.notes && <p className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600 whitespace-pre-line">{p.notes}</p>}
      </div>

      {payments.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6 print:hidden">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">{t("Payments to vendor")}</h2>
          <div className="space-y-2">
            {payments.map((pay) => (
              <div key={pay.id} className={`flex justify-between text-sm ${pay.voided ? "text-slate-400 line-through" : ""}`}>
                <span className={pay.voided ? "" : "text-slate-600"}>
                  {new Date(pay.createdAt).toLocaleDateString()} {pay.method ? `· ${t(pay.method)}` : ""}
                </span>
                <span className="font-medium">{money(pay.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Print-only layout */}
      <div className="hidden print:block text-black">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t("PURCHASE ORDER")}</h1>
            <p className="text-sm font-semibold mt-1">{COMPANY_NAME}</p>
          </div>
          <div className="text-right text-xs leading-5">
            <p>
              <span className="font-semibold">{t("PO No:")}</span> {p.purchaseNumber}
            </p>
            <p>
              <span className="font-semibold">{t("Date:")}</span> {formatDateKey(p.dateKey)}
            </p>
            {p.vendorInvoiceNumber && (
              <p>
                <span className="font-semibold">{t("Vendor Invoice #:")}</span> {p.vendorInvoiceNumber}
              </p>
            )}
            <p>
              <span className="font-semibold">{t("Status:")}</span> {t(purchaseStatusLabel[p.paymentStatus])}
            </p>
          </div>
        </div>
        <hr className="my-3 border-black" />
        <p className="text-xs font-semibold">{t("Vendor:")}</p>
        <p className="text-sm">{p.vendorName}</p>
        <table className="w-full mt-4 text-xs border-collapse border border-black">
          <thead>
            <tr>
              <th className="border border-black py-1 px-1 w-10">{t("NO")}</th>
              <th className="border border-black py-1 px-2 text-left">{t("DESCRIPTION")}</th>
              <th className="border border-black py-1 px-1 w-14">{t("QTY")}</th>
              <th className="border border-black py-1 px-1 w-16">{t("UNIT")}</th>
              <th className="border border-black py-1 px-2 w-24">{t("UNIT COST")}</th>
              <th className="border border-black py-1 px-2 w-24">{t("AMOUNT")}</th>
            </tr>
          </thead>
          <tbody>
            {p.items.map((li, idx) => (
              <tr key={idx}>
                <td className="border border-black text-center py-1">{idx + 1}</td>
                <td className="border border-black px-2 py-1">{li.productName}</td>
                <td className="border border-black text-center py-1">{li.quantity}</td>
                <td className="border border-black text-center px-1 py-1">{li.unit}</td>
                <td className="border border-black text-right px-2 py-1">{money(li.cost)}</td>
                <td className="border border-black text-right px-2 py-1">{money(li.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-between items-start mt-6">
          <div className="text-xs max-w-xs">
            {p.notes && (
              <>
                <p className="font-semibold">{t("Notes:")}</p>
                <p className="mt-0.5 whitespace-pre-line">{p.notes}</p>
              </>
            )}
          </div>
          <div className="text-xs text-right space-y-0.5">
            <p>
              {t("Subtotal:")} {money(p.subtotal)}
            </p>
            {p.shipping > 0 && (
              <p>
                {t("Shipping / fees:")} {money(p.shipping)}
              </p>
            )}
            {p.discount > 0 && (
              <p>
                {t("Discount:")} -{money(p.discount)}
              </p>
            )}
            <p className="border-2 border-black px-3 py-1 font-bold text-sm">
              {t("TOTAL:")} {money(p.total)}
            </p>
            <p>
              {t("Paid:")} {money(p.amountPaid)}
            </p>
            {!isVoid && (
              <p>
                {t("Balance:")} {money(p.balance)}
              </p>
            )}
          </div>
        </div>
      </div>

      {dialog === "pay" && (
        <PayDialog
          purchase={p}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog === "edit" && (
        <EditDialog
          purchase={p}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog === "void" && (
        <VoidDialog
          purchase={p}
          paidCount={payments.filter((x) => !x.voided).length}
          onClose={() => setDialog(null)}
          onDone={(warnings) => {
            setDialog(null);
            setNotice(warnings);
            void load();
          }}
        />
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  const t = useT();
  return (
    <div className={`flex justify-between ${bold ? "font-semibold text-slate-900" : "text-slate-600"}`}>
      <span>{t(label)}</span>
      <span>{value}</span>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/30 print:hidden">
      <div className="w-full md:max-w-md rounded-t-2xl md:rounded-2xl bg-white p-6 shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500";
const primaryCls = "rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50";
const cancelCls = "rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100";

/** Each dialog mount is one action: its operationId stays the same across retries, so a payment is never recorded twice. */
function useSubmit(action: (operationId: string) => Promise<void>) {
  const [operationId] = useState(newOperationId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      await action(operationId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  };
  return { run, busy, error, setError };
}

function PayDialog({ purchase, onClose, onDone }: { purchase: Purchase; onClose: () => void; onDone: () => void }) {
  const { authedFetch } = useAppAuth();
  const t = useT();
  const [amount, setAmount] = useState(String(purchase.balance));
  const [method, setMethod] = useState("");
  const { run, busy, error, setError } = useSubmit(async (opId) => {
    await recordVendorPaymentApi(authedFetch, purchase.id, Number(amount), method, opId);
    onDone();
  });
  return (
    <Modal title={t("Pay {name}", { name: purchase.vendorName })} onClose={onClose}>
      <p className="text-sm text-slate-600">
        {t("Still owed on {n}:", { n: purchase.purchaseNumber })} <span className="font-semibold text-rose-700">{money(purchase.balance)}</span>
      </p>
      <label className="mt-3 block text-xs font-medium text-slate-600">{t("Amount paid ($)")}</label>
      <input type="number" inputMode="decimal" step="0.01" min={0} className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} />
      <label className="mt-3 block text-xs font-medium text-slate-600">{t("How paid (optional)")}</label>
      <input className={inputCls} placeholder={t("Cash, check #, Zelle…")} value={method} onChange={(e) => setMethod(e.target.value)} />
      {error && <p className="mt-3 text-sm text-red-600">{t(error)}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={cancelCls}>
          {t("Cancel")}
        </button>
        <button
          disabled={busy}
          className={primaryCls}
          onClick={() => {
            const n = Number(amount);
            if (!(n > 0)) return setError(t("Enter an amount more than $0."));
            if (n > purchase.balance + 0.001) return setError(t("That is more than what is owed ({amount}).", { amount: money(purchase.balance) }));
            void run();
          }}
        >
          {busy ? t("Saving…") : t("Save payment")}
        </button>
      </div>
    </Modal>
  );
}

function EditDialog({ purchase, onClose, onDone }: { purchase: Purchase; onClose: () => void; onDone: () => void }) {
  const { authedFetch } = useAppAuth();
  const t = useT();
  const [vendorInvoiceNumber, setVendorInvoiceNumber] = useState(purchase.vendorInvoiceNumber);
  const [dateKey, setDateKey] = useState(purchase.dateKey);
  const [notes, setNotes] = useState(purchase.notes);
  const { run, busy, error } = useSubmit(async (opId) => {
    await updatePurchaseInfoApi(authedFetch, purchase.id, { vendorInvoiceNumber: vendorInvoiceNumber.trim(), dateKey, notes }, opId);
    onDone();
  });
  return (
    <Modal title={t("Edit details")} onClose={onClose}>
      <p className="text-xs text-slate-500">{t("To change products, quantities or prices, cancel this purchase and enter it again.")}</p>
      <label className="mt-3 block text-xs font-medium text-slate-600">{t("Vendor's invoice #")}</label>
      <input className={inputCls} value={vendorInvoiceNumber} onChange={(e) => setVendorInvoiceNumber(e.target.value)} />
      <label className="mt-3 block text-xs font-medium text-slate-600">{t("Date")}</label>
      <input type="date" className={inputCls} value={dateKey} onChange={(e) => setDateKey(e.target.value)} />
      <label className="mt-3 block text-xs font-medium text-slate-600">{t("Notes")}</label>
      <textarea rows={3} className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
      {error && <p className="mt-3 text-sm text-red-600">{t(error)}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={cancelCls}>
          {t("Cancel")}
        </button>
        <button disabled={busy} className={primaryCls} onClick={() => void run()}>
          {busy ? t("Saving…") : t("Save")}
        </button>
      </div>
    </Modal>
  );
}

function VoidDialog({ purchase, paidCount, onClose, onDone }: { purchase: Purchase; paidCount: number; onClose: () => void; onDone: (warnings: string[]) => void }) {
  const { authedFetch } = useAppAuth();
  const t = useT();
  const { run, busy, error } = useSubmit(async (opId) => {
    const { stockWarnings } = await voidPurchaseApi(authedFetch, purchase.id, opId);
    onDone(stockWarnings);
  });
  return (
    <Modal title={t("Cancel {n}?", { n: purchase.purchaseNumber })} onClose={onClose}>
      <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
        <li>{t("The quantities it added are taken back out of stock.")}</li>
        <li>{t("It no longer counts as money you owe {name}.", { name: purchase.vendorName })}</li>
        {paidCount > 0 && <li>{t("The {amount} you recorded as paid on it is cancelled too.", { amount: money(purchase.amountPaid) })}</li>}
        <li>{t("It stays in your history, marked Cancelled. This can't be undone.")}</li>
      </ul>
      {error && <p className="mt-3 text-sm text-red-600">{t(error)}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={cancelCls}>
          {t("Keep it")}
        </button>
        <button disabled={busy} className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50" onClick={() => void run()}>
          {busy ? t("Cancelling…") : t("Cancel purchase")}
        </button>
      </div>
    </Modal>
  );
}
