"use client";

import Link from "next/link";
import { X } from "lucide-react";

/**
 * Shown on a list page opened from a chat shortcut button (e.g. /customers?id=…): says what is filtered and offers a
 * one-tap way back to the full list.
 */
export default function ChatFilterBanner({ label, clearHref }: { label: string; clearHref: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-indigo-50 px-4 py-2.5 text-sm text-indigo-800">
      <span>{label}</span>
      <Link href={clearHref} className="flex shrink-0 items-center gap-1 font-medium text-indigo-700 hover:underline">
        <X size={14} /> Xem tất cả
      </Link>
    </div>
  );
}
