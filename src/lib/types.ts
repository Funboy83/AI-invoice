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

/**
 * Delivery orders: goods go out first, prices are set later. A delivery is a normal committed (unpaid) invoice with
 * this tag, so stock and customer debt work as for any invoice. While `status` is "open" a line may have price $0
 * (not "incomplete"); converting sets the final prices and moves it to "converted" — the tag stays for history.
 */
export interface DeliveryInfo {
  status: "open" | "converted";
  convertedAt?: number;
}

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
  /** Present only on delivery orders (see DeliveryInfo). */
  delivery?: DeliveryInfo;
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

/** A delivery order still waiting for its final prices. Voided deliveries are never "open". */
export function isOpenDelivery(invoice: Pick<Invoice, "delivery" | "paymentStatus">): boolean {
  return invoice.delivery?.status === "open" && invoice.paymentStatus !== "void";
}

/** A draft invoice with any line missing quantity/price — needs the user to finish it or delete (void) it. */
export function isInvoiceIncomplete(invoice: Invoice): boolean {
  return invoice.paymentStatus === "draft" && invoice.items.some((it) => it.incomplete);
}

/** Which Custom Invoice print layout to use: KiotViet-style for big vendors, or a lighter one for small vendors. */
export type CustomInvoiceTemplate = "professional" | "simple";

export interface PrintParty {
  name: string;
  address: string;
  phone: string;
  email?: string;
}

/**
 * Extra information printed on a Custom Invoice. A Custom Invoice is NOT a separate invoice: it is a different
 * printout of an existing invoice. Customer, items, prices and totals always come from that invoice and can't be
 * changed here; this only holds the "information and notes" around them. Stored per invoice (doc id = invoice id)
 * in `invoicePrintInfo`, so it never affects debt, stock, payments or the invoice itself.
 */
export interface InvoicePrintInfo {
  invoiceId: string;
  template: CustomInvoiceTemplate;
  /** Your company, printed as the sender. */
  from: PrintParty;
  /** Customer's billing address/phone as printed (the customer NAME always comes from the invoice). */
  billTo: { address: string; phone: string };
  shipTo: PrintParty;
  /** "YYYY-MM-DD" dates printed on the invoice; empty string = not shown. */
  date: string;
  dueDate: string;
  deliveryDate: string;
  po: string;
  notes: string;
  terms: string;
  updatedAt: number;
}

/** Last-used company block and terms, pre-filled on the next Custom Invoice. */
export interface CustomInvoiceDefaults {
  from: PrintParty;
  terms: string;
}

/* ------------------------------ Buying from vendors ------------------------------ */

/** A supplier the store buys stock from — the mirror of Customer on the buying side. */
export interface Vendor {
  id: string;
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

/** One product line on a purchase: what was bought, how many, and what each one cost. */
export interface PurchaseLine {
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
  cost: number;
  lineTotal: number;
}

/** unpaid/partial/paid come from amountPaid vs total; void = cancelled (its stock was taken back out). */
export type PurchaseStatus = "unpaid" | "partial" | "paid" | "void";

/**
 * A purchase (purchase order) from a vendor. Saving one ADDS its quantities to product stock; cancelling it takes
 * exactly those quantities back out. `addedQuantities` is the record of what this purchase added, so a cancel never
 * depends on (possibly since-changed) line items.
 */
export interface Purchase {
  id: string;
  /** Our own number, e.g. "PO-1001". */
  purchaseNumber: string;
  vendorId: string;
  vendorName: string;
  /** The number printed on the vendor's own invoice/receipt — searchable. Empty when not given. */
  vendorInvoiceNumber: string;
  /** Purchase date as "YYYY-MM-DD" (the store's calendar day, independent of time zones). */
  dateKey: string;
  items: PurchaseLine[];
  /** Shipping or other fees charged by the vendor. */
  shipping: number;
  discount: number;
  subtotal: number;
  total: number;
  amountPaid: number;
  balance: number;
  paymentStatus: PurchaseStatus;
  notes: string;
  /** True when saving this purchase also set each product's cost to the price paid here. */
  updatedCost: boolean;
  addedQuantities: { productId: string; quantity: number }[];
  createdAt: number;
  updatedAt: number;
  voidedAt?: number;
}

/** Money paid to a vendor against one purchase. Cancelling the purchase marks its payments as voided (kept for history). */
export interface VendorPayment {
  id: string;
  purchaseId: string;
  vendorId: string;
  amount: number;
  method: string;
  note: string;
  createdAt: number;
  voided?: boolean;
}

/** What is still owed on a purchase: only unpaid/partial purchases count; cancelled ones never do. */
export function purchaseOwed(p: Pick<Purchase, "paymentStatus" | "balance">): number {
  return p.paymentStatus === "unpaid" || p.paymentStatus === "partial" ? p.balance : 0;
}
