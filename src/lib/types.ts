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
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
