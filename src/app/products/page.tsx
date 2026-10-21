"use client";

import { Suspense, useEffect, useState } from "react";
import { watchProducts } from "@/lib/store";
import { useRouter, useSearchParams } from "next/navigation";
import ChatFilterBanner from "@/components/ChatFilterBanner";
import ProductFormModal from "@/components/ProductFormModal";
import { useAppAuth } from "@/lib/useAppAuth";
import type { Product } from "@/lib/types";
import { Plus, Pencil, ChevronRight } from "lucide-react";
import { useT } from "@/lib/useLang";

// useSearchParams (filters opened from a chat shortcut) needs a Suspense boundary to build.
export default function ProductsPage() {
  return (
    <Suspense fallback={null}>
      <ProductsPageContent />
    </Suspense>
  );
}

function ProductsPageContent() {
  const { reportListenerError } = useAppAuth();
  const t = useT();
  const [allProducts, setProducts] = useState<Product[]>([]);
  // Opened from a chat shortcut (/products?id=…): show just that product.
  const focusId = useSearchParams().get("id");
  // Inactive products stay hidden unless the "Show inactive" toggle is on (a chat link to one product still shows it).
  const [showInactive, setShowInactive] = useState(false);
  const inactiveCount = allProducts.filter((p) => !p.active).length;
  const products = focusId
    ? allProducts.filter((p) => p.id === focusId)
    : showInactive
      ? allProducts
      : allProducts.filter((p) => p.active);
  const emptyMessage =
    !showInactive && inactiveCount > 0 ? t("No active products. Tap \"Show inactive\" to see hidden ones.") : null;

  // null = closed; "new" = Add product; a product = editing it (the same form the product page's Edit opens).
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const router = useRouter();

  useEffect(() => watchProducts(setProducts, reportListenerError), [reportListenerError]);

  const openProduct = (p: Product) => router.push(`/products/${p.id}`);

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 pb-24 md:pb-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{t("Products")}</h1>
          <p className="text-sm text-slate-500 mt-1">{t("Catalog with aliases so the AI recognizes nicknames & typos.")}</p>
        </div>
        <button
          onClick={() => setEditing("new")}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={16} /> {t("Add product")}
        </button>
      </div>

      {/* Desktop table */}
      {focusId && <ChatFilterBanner label={t("Showing the product opened from chat")} clearHref="/products" />}

      {!focusId && (
        <div className="flex justify-end">
          <button
            onClick={() => setShowInactive((v) => !v)}
            className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
              showInactive
                ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {showInactive ? t("Hide inactive") : t("Show inactive ({n})", { n: inactiveCount })}
          </button>
        </div>
      )}

      <div className="hidden md:block rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-5 py-3 font-medium">{t("Name")}</th>
              <th className="text-left px-5 py-3 font-medium">{t("Aliases")}</th>
              <th className="text-right px-5 py-3 font-medium">{t("Price")}</th>
              <th className="text-left px-5 py-3 font-medium">{t("Unit")}</th>
              <th className="text-right px-5 py-3 font-medium">{t("Stock")}</th>
              <th className="text-left px-5 py-3 font-medium">{t("Category")}</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {products.map((p) => (
              <tr key={p.id} onClick={() => openProduct(p)} className={`cursor-pointer hover:bg-slate-50 ${p.active ? "" : "opacity-60"}`}>
                <td className="px-5 py-3 font-medium text-slate-900">
                  {p.name}
                  {!p.active && <InactiveBadge />}
                </td>
                <td className="px-5 py-3 text-slate-500">
                  <div className="flex flex-wrap gap-1">
                    {p.aliases.slice(0, 4).map((a) => (
                      <span key={a} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px]">
                        {a}
                      </span>
                    ))}
                    {p.aliases.length === 0 && "—"}
                  </div>
                </td>
                <td className="px-5 py-3 text-right text-slate-900">${p.defaultPrice.toFixed(2)}</td>
                <td className="px-5 py-3 text-slate-500">{p.defaultUnit}</td>
                <td className={`px-5 py-3 text-right font-medium ${p.quantity !== undefined && p.quantity < 0 ? "text-red-600" : "text-slate-900"}`}>
                  {p.quantity !== undefined ? p.quantity : <span className="text-xs text-slate-400">{t("Not counted")}</span>}
                </td>
                <td className="px-5 py-3 text-slate-500">{p.category || "—"}</td>
                <td className="px-5 py-3 text-right">
                  <button
                    onClick={(e) => {
                      e.stopPropagation(); // the pencil edits right here; the rest of the row opens the product page
                      setEditing(p);
                    }}
                    title={t("Edit")}
                    className="text-slate-400 hover:text-indigo-600"
                  >
                    <Pencil size={15} />
                  </button>
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-slate-400">
                  {emptyMessage ?? t("No products yet. Add one manually, or paste an order to the AI and it will offer to create it.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {products.map((p) => (
          <button
            key={p.id}
            onClick={() => openProduct(p)}
            className={`w-full text-left rounded-2xl border border-slate-200 bg-white p-4 active:bg-slate-50 ${p.active ? "" : "opacity-60"}`}
          >
            <div className="flex items-center justify-between">
              <p className="font-medium text-slate-900">
                {p.name}
                {!p.active && <InactiveBadge />}
              </p>
              <p className="flex items-center gap-1 font-semibold text-slate-900">
                ${p.defaultPrice.toFixed(2)}
                <ChevronRight size={16} className="text-slate-400" />
              </p>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {p.defaultUnit}
              {p.category ? ` · ${p.category}` : ""}
              {p.quantity !== undefined ? (
                <span className={`font-medium ${p.quantity < 0 ? "text-red-600" : "text-slate-700"}`}> · {t("stock: {n}", { n: p.quantity })}</span>
              ) : (
                <span className="text-slate-400"> · {t("stock: not counted")}</span>
              )}
            </p>
            {p.aliases.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {p.aliases.slice(0, 4).map((a) => (
                  <span key={a} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                    {a}
                  </span>
                ))}
              </div>
            )}
          </button>
        ))}
        {products.length === 0 && (
          <p className="text-center text-sm text-slate-400 py-10">{emptyMessage ?? t("No products yet.")}</p>
        )}
      </div>

      {editing && <ProductFormModal product={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function InactiveBadge() {
  const t = useT();
  return (
    <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 align-middle text-[11px] font-medium text-slate-600">
      {t("Inactive")}
    </span>
  );
}
