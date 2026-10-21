import { formatDateKey, lines, money, type PrintProps } from "./shared";
import { useT } from "@/lib/useLang";

/**
 * "Simple" Custom Invoice print (for small vendors): a clean one-page layout like the reference POS's custom invoice —
 * company block, invoice details, Bill To / Ship To, Qty·Description·Unit Price·Amount, totals, notes and terms.
 */
export default function SimplePrint({ invoice, info }: PrintProps) {
  const t = useT();
  const details: [string, string][] = [
    [t("Invoice #"), invoice.invoiceNumber],
    [t("Invoice Date"), formatDateKey(info.date)],
    [t("P.O. #"), info.po],
    [t("Due Date"), formatDateKey(info.dueDate)],
    [t("Delivery Date"), formatDateKey(info.deliveryDate)],
  ];

  return (
    <div className="text-slate-900 font-[Arial,Helvetica,sans-serif] text-[12px] leading-snug">
      <div className="flex items-start justify-between gap-6">
        <div>
          <p className="text-[17px] font-bold">{info.from.name}</p>
          {lines(info.from.address).map((l, i) => (
            <p key={i}>{l}</p>
          ))}
          {info.from.phone && <p>{info.from.phone}</p>}
          {info.from.email && <p>{info.from.email}</p>}
        </div>
        <h1 className="text-[30px] font-light tracking-[0.2em] text-slate-700">{t("INVOICE")}</h1>
      </div>

      <div className="mt-6 grid grid-cols-[1fr_1fr_auto] gap-6">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-300 pb-0.5 mb-1">{t("Bill To")}</p>
          <p className="font-semibold">{invoice.customerName}</p>
          {lines(info.billTo.address).map((l, i) => (
            <p key={i}>{l}</p>
          ))}
          {info.billTo.phone && <p>{info.billTo.phone}</p>}
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-300 pb-0.5 mb-1">{t("Ship To")}</p>
          {info.shipTo.name && <p className="font-semibold">{info.shipTo.name}</p>}
          {lines(info.shipTo.address).map((l, i) => (
            <p key={i}>{l}</p>
          ))}
          {info.shipTo.phone && <p>{info.shipTo.phone}</p>}
        </div>
        <table className="self-start">
          <tbody>
            {details
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <tr key={k}>
                  <td className="pr-3 font-semibold text-slate-600">{k}</td>
                  <td className="text-right">{v}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <table className="w-full mt-6 border-collapse">
        <thead>
          <tr className="bg-slate-800 text-white text-[11px]">
            <th className="py-1.5 px-2 text-left w-14">{t("Qty")}</th>
            <th className="py-1.5 px-2 text-left">{t("Description")}</th>
            <th className="py-1.5 px-2 text-right w-24">{t("Unit Price")}</th>
            <th className="py-1.5 px-2 text-right w-24">{t("Amount")}</th>
          </tr>
        </thead>
        <tbody>
          {invoice.items.map((li, idx) => (
            <tr key={idx} className="border-b border-slate-200 break-inside-avoid">
              <td className="py-1.5 px-2">{li.quantity}</td>
              <td className="py-1.5 px-2">
                {li.productName}
                {li.unit?.trim() && <span className="text-slate-500"> ({li.unit.trim()})</span>}
              </td>
              <td className="py-1.5 px-2 text-right">{money(li.price)}</td>
              <td className="py-1.5 px-2 text-right">{money(li.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex justify-end break-inside-avoid">
        <div className="w-60 space-y-1">
          <div className="flex justify-between">
            <span className="text-slate-600">{t("Subtotal")}</span>
            <span>{money(invoice.subtotal)}</span>
          </div>
          {invoice.shipping > 0 && (
            <div className="flex justify-between">
              <span className="text-slate-600">{t("Shipping")}</span>
              <span>{money(invoice.shipping)}</span>
            </div>
          )}
          {invoice.discount > 0 && (
            <div className="flex justify-between">
              <span className="text-slate-600">{t("Discount")}</span>
              <span>-{money(invoice.discount)}</span>
            </div>
          )}
          <div className="flex justify-between border-t-2 border-slate-800 pt-1 text-[14px] font-bold">
            <span>{t("Total")}</span>
            <span>{money(invoice.total)}</span>
          </div>
        </div>
      </div>

      {info.notes && (
        <div className="mt-6 break-inside-avoid">
          <p className="font-semibold">{t("Notes")}</p>
          <p className="whitespace-pre-line">{info.notes}</p>
        </div>
      )}
      {info.terms && (
        <div className="mt-4 text-[10px] text-slate-600 whitespace-pre-line break-inside-avoid">
          <p className="font-semibold text-slate-800 text-[11px]">{t("Terms & Conditions")}</p>
          {info.terms}
        </div>
      )}
      <p className="mt-8 text-center text-slate-500">{t("Thank you for your business!")}</p>
    </div>
  );
}
