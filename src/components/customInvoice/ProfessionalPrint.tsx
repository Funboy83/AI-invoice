import { formatDateKey, lines, money, totalQuantity, type PrintProps } from "./shared";
import { useT } from "@/lib/useLang";

/**
 * "Professional" Custom Invoice print (for big vendors), copied from the KiotViet business invoice: INVOICE title and
 * underlined company block, Bill To / Ship To / Invoice / Date / Delivery Date, STT·CODE·ITEMS NAME·Unit·QTT·Price·Total
 * table, stepped totals, Terms & Conditions. Customer, items and money come straight from the invoice.
 */
export default function ProfessionalPrint({ invoice, info }: PrintProps) {
  const t = useT();
  const companyLines = [info.from.name, ...lines(info.from.address), info.from.phone ? `${t("TEL:")} ${info.from.phone}` : ""].filter(Boolean);

  return (
    <div className="text-black font-[Arial,Helvetica,sans-serif] text-[11px] leading-snug">
      <div className="flex items-start justify-between">
        <h1 className="text-[44px] leading-none text-[#1f3a8a] underline decoration-2 underline-offset-4 [font-family:Impact,'Arial_Narrow',sans-serif] [font-stretch:condensed]">
          {t("INVOICE")}
        </h1>
        <div className="text-right font-bold underline leading-tight uppercase">
          {companyLines.map((line, i) => (
            <p key={i} className={i === 0 ? "text-[13px]" : "text-[11px]"}>
              {line}
            </p>
          ))}
        </div>
      </div>
      <hr className="mt-5 mb-2 border-black/40" />

      <div className="grid grid-cols-[1.3fr_1fr_1fr] gap-x-3">
        <div>
          <p className="font-bold">{t("Bill To:")}</p>
          <p>{invoice.customerName}</p>
          {lines(info.billTo.address).map((l, i) => (
            <p key={i}>{l}</p>
          ))}
          <p>{t("Tel:")} {info.billTo.phone}</p>
        </div>
        <div>
          <p className="font-bold">{t("Ship To:")}</p>
          {info.shipTo.name && <p>{info.shipTo.name}</p>}
          {lines(info.shipTo.address).map((l, i) => (
            <p key={i}>{l}</p>
          ))}
          <p>{t("Tel:")} {info.shipTo.phone}</p>
        </div>
        <div className="text-right space-y-0.5">
          <p>
            <span className="font-bold">{t("Invoice")}</span>: {invoice.invoiceNumber}
          </p>
          <p>
            <span className="font-bold">{t("Date")}</span>: {formatDateKey(info.date, " / ")}
          </p>
          {info.po && (
            <p>
              <span className="font-bold">{t("P.O. #")}</span>: {info.po}
            </p>
          )}
          {info.dueDate && (
            <p>
              <span className="font-bold">{t("Due Date")}</span>: {formatDateKey(info.dueDate, " / ")}
            </p>
          )}
          <p>
            <span className="font-bold">{t("Delivery Date:")}</span> {formatDateKey(info.deliveryDate, " / ")}
          </p>
        </div>
      </div>

      <table className="w-full mt-3 border-collapse border border-black">
        <thead>
          <tr className="font-bold">
            <th className="border border-black px-1 py-0.5 w-10">{t("STT")}</th>
            <th className="border border-black px-1 py-0.5 w-20">{t("CODE")}</th>
            <th className="border border-black px-1 py-0.5">{t("ITEMS NAME")}</th>
            <th className="border border-black px-1 py-0.5 w-28">{t("Unit")}</th>
            <th className="border border-black px-1 py-0.5 w-14">{t("QTT")}</th>
            <th className="border border-black px-1 py-0.5 w-20">{t("Price")}</th>
            <th className="border border-black px-1 py-0.5 w-24">{t("Total")}</th>
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

      {/* Labels indented under the table, values stepped right like the KiotViet print. */}
      <div className="mt-4 ml-8 grid grid-cols-[1fr_5rem_7rem_7rem] gap-y-1 break-inside-avoid">
        <span>{t("Total Items")}</span>
        <span className="text-right">{totalQuantity(invoice)}</span>
        <span />
        <span />
        <span>{t("Total Price")}</span>
        <span />
        <span className="text-right">{money(invoice.subtotal)}</span>
        <span />
        {invoice.shipping > 0 && (
          <>
            <span>{t("Shipping")}</span>
            <span />
            <span className="text-right">{money(invoice.shipping)}</span>
            <span />
          </>
        )}
        <span>{t("Discount")}</span>
        <span className="text-right">{money(invoice.discount)}</span>
        <span />
        <span />
        <span>{t("TOTAL INVOICE")}</span>
        <span />
        <span />
        <span className="text-right">{money(invoice.total)}</span>
      </div>
      <hr className="mt-5 mb-4 border-black/40" />

      {info.notes && <p className="mb-4 whitespace-pre-line">{info.notes}</p>}
      <div className="text-[8.5px] leading-tight uppercase whitespace-pre-line break-inside-avoid">
        <p className="normal-case">{t("Terms & Conditions")}</p>
        {info.terms}
      </div>
    </div>
  );
}
