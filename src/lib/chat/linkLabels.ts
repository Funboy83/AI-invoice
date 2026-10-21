import type { Lang } from "@/lib/i18n/translate";

/**
 * Shortcut-button labels are made on the server in Vietnamese and saved with each reply (see links.ts), so old replies
 * keep theirs. In English they are rewritten here when shown; anything not recognised is shown as it was saved.
 */
const PATTERNS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^Mở invoice #(.+)$/, (m) => `Open invoice #${m[1]}`],
  [/^Mở invoice$/, () => "Open invoice"],
  [/^Khách: (.+)$/, (m) => `Customer: ${m[1]}`],
  [/^Xem khách hàng$/, () => "See customer"],
  [/^Sản phẩm: (.+)$/, (m) => `Product: ${m[1]}`],
  [/^Xem sản phẩm$/, () => "See product"],
  [/^Invoice của khách này$/, () => "This customer's invoices"],
  [/^Xem danh sách invoice$/, () => "See invoice list"],
  [/^Invoice chưa thanh toán$/, () => "Unpaid invoices"],
  [/^Đơn giao hàng chưa chốt giá$/, () => "Delivery orders without final prices"],
];

export function translateChatLink(label: string, lang: Lang): string {
  if (lang === "vi") return label;
  for (const [re, fn] of PATTERNS) {
    const m = label.match(re);
    if (m) return fn(m);
  }
  return label;
}
