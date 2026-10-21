import Link from "next/link";
import { formatDateKey, money, purchaseStatusLabel, purchaseStatusStyles } from "@/lib/purchaseApi";
import { purchaseOwed, type Purchase } from "@/lib/types";
import { ChevronRight } from "lucide-react";
import { useT } from "@/lib/useLang";

/** One purchase in a list (purchase history, vendor page): number, status, date, vendor invoice #, total and what is owed. */
export default function PurchaseRow({ p, showVendor }: { p: Purchase; showVendor?: boolean }) {
  const t = useT();
  return (
    <Link href={`/purchases/${p.id}`} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 hover:bg-slate-50 active:bg-slate-50 print:rounded-none print:border-x-0 print:border-t-0 print:p-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-slate-900">{p.purchaseNumber}</p>
          <span className={`text-[10px] uppercase font-medium px-2 py-0.5 rounded-full ${purchaseStatusStyles[p.paymentStatus]}`}>{t(purchaseStatusLabel[p.paymentStatus])}</span>
        </div>
        <p className="text-xs text-slate-500 mt-1">
          {formatDateKey(p.dateKey)}
          {showVendor && ` · ${p.vendorName}`}
          {p.vendorInvoiceNumber && ` · ${t("Vendor inv #{n}", { n: p.vendorInvoiceNumber })}`}
        </p>
      </div>
      <div className="text-right text-sm">
        <p className={`font-semibold ${p.paymentStatus === "void" ? "text-slate-400 line-through" : "text-slate-900"}`}>{money(p.total)}</p>
        {purchaseOwed(p) > 0 && <p className="text-xs font-medium text-rose-700">{t("Owe {amount}", { amount: money(p.balance) })}</p>}
      </div>
      <ChevronRight size={16} className="shrink-0 text-slate-400 print:hidden" />
    </Link>
  );
}
