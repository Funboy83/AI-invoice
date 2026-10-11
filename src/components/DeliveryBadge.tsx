import { Truck } from "lucide-react";
import { isOpenDelivery, type Invoice } from "@/lib/types";

/** "Delivery" tag on an invoice: purple while it still waits for its final prices, grey once converted. */
export default function DeliveryBadge({ invoice, size = "sm" }: { invoice: Pick<Invoice, "delivery" | "paymentStatus">; size?: "sm" | "md" }) {
  if (!invoice.delivery) return null;
  const open = isOpenDelivery(invoice);
  const text = size === "md" ? "text-xs px-2.5 py-1" : "text-[11px] px-2 py-0.5";
  return (
    <span
      className={`inline-flex items-center gap-1 font-medium rounded-full ${text} ${open ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-600"}`}
      title={open ? "Delivery order — prices are set later" : "Delivery order — converted to final invoice"}
    >
      <Truck size={size === "md" ? 13 : 11} /> {open ? "Delivery · chưa chốt giá" : "Delivery"}
    </span>
  );
}
