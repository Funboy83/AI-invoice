/**
 * The PDF name for a print: the customer's name with no spaces or accents, then the date as DD-MM-YY,
 * e.g. "Asia Pacific" on 2026-10-20 → "AsiaPacific20-10-26". dateKey is "YYYY-MM-DD".
 */
export function printFileName(name: string, dateKey: string): string {
  const plain = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9]+/g, "");
  const [y, m, d] = dateKey.split("-");
  const date = y && m && d ? `${d}-${m}-${y.slice(-2)}` : "";
  return `${plain}${date}` || "invoice";
}
