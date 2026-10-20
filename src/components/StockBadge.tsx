import type { Product } from "@/lib/types";

/** Stock on hand for the product picker. Display only: a sale is never blocked by low or negative stock. */
export default function StockBadge({ product }: { product: Product }) {
  if (product.quantity === undefined) {
    return <span className="w-16 text-right text-xs text-slate-400">Not counted</span>;
  }
  const out = product.quantity <= 0;
  return (
    <span className={`w-16 text-right text-xs font-medium ${out ? "text-red-600" : "text-slate-600"}`}>
      Stock {product.quantity}
    </span>
  );
}
