import { formatDateKey } from "@/lib/businessApi";
import type { CustomInvoice } from "@/lib/types";

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Print-only layout for a Custom Invoice, copied from the KiotViet business invoice: INVOICE title and company block,
 * Bill To / Ship To / invoice number and date, STT·CODE·ITEMS NAME·Unit·QTT·Price·Total table, stepped totals, and
 * Terms & Conditions. Hidden on screen. Separate from (and does not change) the normal invoice's print template.
 */
export default function CustomInvoicePrint({ invoice, header, terms }: { invoice: CustomInvoice; header: string; terms: string }) {
  const totalQty = Math.round(invoice.items.reduce((s, li) => s + li.quantity, 0) * 1000) / 1000;
  const headerLines = header.split("\n").filter(Boolean);

  return (
    <div className="hidden print:block text-black font-[Arial,Helvetica,sans-serif] text-[11px] leading-snug">
      <div className="flex items-start justify-between">
        <h1 className="text-[44px] leading-none text-[#1f3a8a] underline decoration-2 underline-offset-4 [font-family:Impact,'Arial_Narrow',sans-serif] [font-stretch:condensed]">
          INVOICE
        </h1>
        <div className="text-right font-bold underline leading-tight">
          {headerLines.map((line, i) => (
            <p key={i} className={i === 0 ? "text-[13px]" : "text-[11px]"}>
              {line}
            </p>
          ))}
        </div>
      </div>
      <hr className="mt-5 mb-2 border-black/40" />

      <div className="grid grid-cols-[1.3fr_1fr_1fr] gap-x-3">
        <div>
          <p className="font-bold">Bill To:</p>
          <p>{invoice.customerName}</p>
          {invoice.billToAddress && <p className="whitespace-pre-line">{invoice.billToAddress}</p>}
          <p>Tel: {invoice.phone ?? ""}</p>
        </div>
        <div>
          <p className="font-bold">Ship To:</p>
          {invoice.shipToAddress && <p className="whitespace-pre-line">{invoice.shipToAddress}</p>}
          <p className={invoice.shipToAddress ? "" : "mt-[2.6em]"}>Tel:</p>
        </div>
        <div className="text-right">
          <p>
            <span className="font-bold">Invoice</span>: {invoice.invoiceNumber}
          </p>
          <p className="mt-1">
            <span className="font-bold">Date</span>: {formatDateKey(invoice.date, " / ")}
          </p>
          <p className="mt-2 font-bold">Delivery Date:</p>
        </div>
      </div>

      <table className="w-full mt-3 border-collapse border border-black">
        <thead>
          <tr className="font-bold">
            <th className="border border-black px-1 py-0.5 w-10">STT</th>
            <th className="border border-black px-1 py-0.5 w-20">CODE</th>
            <th className="border border-black px-1 py-0.5">ITEMS NAME</th>
            <th className="border border-black px-1 py-0.5 w-28">Unit</th>
            <th className="border border-black px-1 py-0.5 w-14">QTT</th>
            <th className="border border-black px-1 py-0.5 w-20">Price</th>
            <th className="border border-black px-1 py-0.5 w-24">Total</th>
          </tr>
        </thead>
        <tbody>
          {invoice.items.map((li, idx) => (
            <tr key={idx} className="break-inside-avoid">
              <td className="border border-black px-1 py-0.5 text-center">{idx + 1}</td>
              <td className="border border-black px-1 py-0.5">{li.barcode ?? ""}</td>
              <td className="border border-black px-1 py-0.5">{li.productName}</td>
              <td className="border border-black px-1 py-0.5 text-center">{li.unit?.trim() || ""}</td>
              <td className="border border-black px-1 py-0.5 text-center">{li.quantity}</td>
              <td className="border border-black px-1 py-0.5 text-right">{money(li.price)}</td>
              <td className="border border-black px-1 py-0.5 text-right">{money(li.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals block: labels indented under the table, values stepped right like the KiotViet print. */}
      <div className="mt-4 ml-8 grid grid-cols-[1fr_5rem_7rem_7rem] gap-y-1 break-inside-avoid">
        <span>Total Items</span>
        <span className="text-right">{totalQty}</span>
        <span />
        <span />
        <span>Total Price</span>
        <span />
        <span className="text-right">{money(invoice.subtotal)}</span>
        <span />
        {invoice.shipping > 0 && (
          <>
            <span>Shipping</span>
            <span />
            <span className="text-right">{money(invoice.shipping)}</span>
            <span />
          </>
        )}
        <span>Discount</span>
        <span className="text-right">{money(invoice.discount)}</span>
        <span />
        <span />
        <span>TOTAL INVOICE</span>
        <span />
        <span />
        <span className="text-right">{money(invoice.total)}</span>
      </div>
      <hr className="mt-5 mb-8 border-black/40" />

      <div className="text-[8.5px] leading-tight uppercase whitespace-pre-line break-inside-avoid">
        <p className="normal-case">Terms &amp; Conditions</p>
        {terms}
      </div>
    </div>
  );
}
