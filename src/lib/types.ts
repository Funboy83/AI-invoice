export interface Product {
  id: string;
  name: string;
  aliases: string[];
  barcode?: string;
  description?: string;
  category?: string;
  defaultUnit: string;
  defaultPrice: number;
  cost?: number;
  /** Stock tracking is opt-in: undefined means this product's stock is not tracked and invoicing never touches it. */
  quantity?: number;
  active: boolean;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Customer {
  id: string;
  name: string;
  aliases: string[];
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;
  shippingAddress?: string;
  notes?: string;
  defaultShipping?: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface InvoiceLineItem {
  productId?: string;
  productName: string;
  quantity: number;
  unit: string;
  price: number;
  lineTotal: number;
  barcode?: string;
  /** True when quantity and/or price couldn't be determined when the AI parsed the order. */
  incomplete?: boolean;
}

export type InvoiceStatus = "draft" | "unpaid" | "partial" | "paid" | "void";

export interface Invoice {
  id: string;
  invoiceNumber: string;
  date: number;
  customerId?: string;
  customerName: string;
  originalOrderText?: string;
  items: InvoiceLineItem[];
  shipping: number;
  discount: number;
  subtotal: number;
  total: number;
  amountPaid: number;
  balance: number;
  paymentStatus: InvoiceStatus;
  notes?: string;
  createdAt: number;
  updatedAt: number;
  createdBy: "ai" | "user";
  /** Snapshot of what's currently deducted from tracked products' stock for this invoice — the source of truth for
   *  reversing/adjusting stock on edit or void, independent of (possibly since-changed) `items`. Empty/absent while
   *  the invoice is a draft or void (nothing committed). */
  deductedQuantities?: { productId: string; quantity: number }[];
}

/** draft/void never hold stock; unpaid/partial/paid do — the one place this rule is defined. */
export function isCommittedStatus(status: InvoiceStatus): boolean {
  return status !== "draft" && status !== "void";
}

export type LogActor = "ai" | "user";

export interface Payment {
  id: string;
  invoiceId: string;
  customerId?: string;
  amount: number;
  method?: string;
  note?: string;
  createdAt: number;
  actor: LogActor;
}

export interface InvoiceLog {
  id: string;
  invoiceId: string;
  timestamp: number;
  actor: LogActor;
  action: "create" | "update" | "payment" | "void" | "delete";
  message: string;
  before?: unknown;
  after?: unknown;
  /** Set when an AI job made the change — ties the audit entry to the exact tool call that produced it. */
  operationId?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** A draft invoice with any line missing quantity/price — needs the user to finish it or delete (void) it. */
export function isInvoiceIncomplete(invoice: Invoice): boolean {
  return invoice.paymentStatus === "draft" && invoice.items.some((it) => it.incomplete);
}
