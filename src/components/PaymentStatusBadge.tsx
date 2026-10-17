import { CheckCircle2, CircleDashed, Circle, FileText, Ban } from "lucide-react";
import type { InvoiceStatus } from "@/lib/types";

/** Easy-to-see payment tag: green Paid, amber Partial, red Unpaid (plus grey Draft / Void). */
const STYLES: Record<InvoiceStatus, { label: string; cls: string; Icon: typeof Circle }> = {
  paid: { label: "Paid", cls: "bg-emerald-100 text-emerald-800 ring-emerald-300", Icon: CheckCircle2 },
  partial: { label: "Partial", cls: "bg-amber-100 text-amber-800 ring-amber-300", Icon: CircleDashed },
  unpaid: { label: "Unpaid", cls: "bg-rose-100 text-rose-700 ring-rose-300", Icon: Circle },
  draft: { label: "Draft", cls: "bg-slate-100 text-slate-600 ring-slate-300", Icon: FileText },
  void: { label: "Void", cls: "bg-slate-200 text-slate-500 ring-slate-300 line-through", Icon: Ban },
};

export default function PaymentStatusBadge({ status, size = "sm" }: { status: InvoiceStatus; size?: "sm" | "md" }) {
  const s = STYLES[status] ?? STYLES.draft;
  const text = size === "md" ? "text-sm px-3 py-1 gap-1.5" : "text-xs px-2 py-0.5 gap-1";
  return (
    <span className={`inline-flex items-center rounded-full font-semibold ring-1 ring-inset ${text} ${s.cls}`}>
      <s.Icon size={size === "md" ? 14 : 12} strokeWidth={2.5} /> {s.label}
    </span>
  );
}
