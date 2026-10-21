import { chat } from "./vi/chat";
import { common } from "./vi/common";
import { customerForms, customers } from "./vi/customers";
import { dashboard } from "./vi/dashboard";
import { invoiceDetail, invoices } from "./vi/invoices";
import { nav } from "./vi/nav";
import { customInvoicePage, customPrints, prints } from "./vi/prints";
import { productForms, products } from "./vi/products";
import { purchases } from "./vi/purchases";

/** English screen text → Vietnamese. Split by area of the app; see translate.ts. */
export const vi: Record<string, string> = {
  ...nav,
  ...common,
  ...chat,
  ...dashboard,
  ...invoices,
  ...invoiceDetail,
  ...customers,
  ...customerForms,
  ...prints,
  ...customPrints,
  ...customInvoicePage,
  ...products,
  ...productForms,
  ...purchases,
};
