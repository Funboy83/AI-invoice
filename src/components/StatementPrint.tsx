import { money } from "@/components/customInvoice/shared";
import { statementOwed, statementTotals } from "@/lib/customerInvoices";
import type { Customer, Invoice } from "@/lib/types";

const COMPANY_NAME = process.env.NEXT_PUBLIC_COMPANY_NAME || "Ngan";

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

const tagStyles: Record<string, string> = {
  paid: "text-[#166534] border-[#166534]",
  partial: "text-[#92400e] border-[#b45309]",
  unpaid: "text-[#991b1b] border-[#991b1b]",
};

const cell = "border border-black px-1 py-px whitespace-nowrap";

/**
 * Payment request (statement) print for one customer: several invoices, each with its item lines in small (8px) text,
 * its total / paid / still owed, then the grand total and TOTAL STILL OWED. Compact layout from the
 * notes/print-samples mockup; header styled like the Custom Invoice "Professional" print. Display only.
 */
export default function StatementPrint({ customer, invoices, printedAt }: { customer: Customer; invoices: Invoice[]; printedAt: number }) {
  const totals = statementTotals(invoices);
  const dates = invoices.map((i) => i.date);

  return (
    <div className="text-black font-[Arial,Helvetica,sans-serif] text-[11px] leading-snug">
      <div className="flex items-start justify-between">
        <h1 className="text-[34px] leading-none text-[#1f3a8a] underline decoration-2 underline-offset-4 [font-family:Impact,'Arial_Narrow',sans-serif] [font-stretch:condensed]">
          STATEMENT
        </h1>
        <p className="text-right text-[13px] font-bold underline uppercase">{COMPANY_NAME}</p>
      </div>
      <hr className="mt-3 mb-1.5 border-black/40" />

      <div className="grid grid-cols-[1.3fr_1fr] gap-2">
        <div>
          <p className="font-bold">Customer:</p>
          <p>{customer.name}</p>
          {customer.address && <p className="whitespace-pre-line">{customer.address}</p>}
          {customer.phone && <p>Tel: {customer.phone}</p>}
        </div>
        <div className="text-right">
          {dates.length > 0 && (
            <p>
              <span className="font-bold">Period:</span> {fmtDate(Math.min(...dates))} – {fmtDate(Math.max(...dates))}
            </p>
          )}
          <p>
            <span className="font-bold">Printed:</span> {fmtDate(printedAt)}
          </p>
          <p>
            <span className="font-bold">Invoices:</span> {totals.count}
          </p>
        </div>
      </div>

      {invoices.length === 0 && <p className="mt-6 text-center text-slate-500">No invoices picked.</p>}

      {invoices.map((inv) => (
        <section key={inv.id} className="mt-2 break-inside-avoid">
          <div className="flex items-center gap-4 border border-b-0 border-black bg-[#eef2fb] px-1.5 py-0.5">
            <span className="font-bold">Invoice {inv.invoiceNumber}</span>
            <span>Date: {fmtDate(inv.date)}</span>
            <span className={`ml-auto rounded-full border px-1.5 text-[9.5px] font-bold capitalize ${tagStyles[inv.paymentStatus] ?? ""}`}>
              {inv.paymentStatus}
            </span>
          </div>
          <table className="w-full table-fixed border-collapse text-[8px] leading-tight">
            <thead>
              <tr className="bg-[#fafafa] font-bold">
                <th className={`${cell} w-[22px]`}>#</th>
                <th className={`${cell} text-left`}>Product</th>
                <th className={`${cell} w-[38px]`}>Qty</th>
                <th className={`${cell} w-[44px]`}>Unit</th>
                <th className={`${cell} w-[62px] text-right`}>Price</th>
                <th className={`${cell} w-[72px] text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.items.map((li, idx) => (
                <tr key={idx}>
                  <td className={`${cell} text-center`}>{idx + 1}</td>
                  <td className={`${cell} overflow-hidden text-ellipsis`}>{li.productName}</td>
                  <td className={`${cell} text-center`}>{li.quantity}</td>
                  <td className={`${cell} text-center overflow-hidden`}>{li.unit?.trim() || ""}</td>
                  <td className={`${cell} text-right`}>{money(li.price)}</td>
                  <td className={`${cell} text-right`}>{money(li.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap justify-end gap-x-5 border border-t-0 border-black px-1.5 py-px text-[10px]">
            {inv.shipping > 0 && <span>Shipping {money(inv.shipping)}</span>}
            {inv.discount > 0 && <span>Discount {money(inv.discount)}</span>}
            <span>
              Invoice total <b>{money(inv.total)}</b>
            </span>
            <span>Paid {money(inv.amountPaid)}</span>
            <span>
              Still owed <b>{money(statementOwed(inv))}</b>
            </span>
          </div>
        </section>
      ))}

      <div className="mt-3.5 ml-auto w-[290px] border-t-2 border-black pt-1.5 break-inside-avoid">
        <div className="flex justify-between py-0.5">
          <span>
            Total of {totals.count} invoice{totals.count === 1 ? "" : "s"}
          </span>
          <b>{money(totals.totalBilled)}</b>
        </div>
        <div className="flex justify-between py-0.5">
          <span>Total paid</span>
          <span>{money(totals.totalPaid)}</span>
        </div>
        <div className="mt-1 flex justify-between border-t border-black pt-1 text-[14px] font-bold text-[#991b1b]">
          <span>TOTAL STILL OWED</span>
          <span>{money(totals.totalOwed)}</span>
        </div>
      </div>
      <p className="mt-3.5 text-[8.5px] uppercase">Thank you for your business. Please pay the oldest invoice first.</p>
    </div>
  );
}
