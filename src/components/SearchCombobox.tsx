"use client";

import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { findSimilar } from "@/lib/similarity";

interface SearchComboboxProps<T> {
  items: T[];
  getId: (item: T) => string;
  getLabel: (item: T) => string;
  getSubLabel?: (item: T) => string;
  value: string;
  onQueryChange: (query: string) => void;
  onSelect: (item: T) => void;
  onCreateNew?: (query: string) => void;
  placeholder?: string;
  createLabel?: string;
}

/**
 * Live-search textbox over an already-loaded Firestore collection: shows
 * matching results as you type, and a "create new" option when nothing matches.
 */
export default function SearchCombobox<T>({
  items,
  getId,
  getLabel,
  getSubLabel,
  value,
  onQueryChange,
  onSelect,
  onCreateNew,
  placeholder,
  createLabel = "Add new",
}: SearchComboboxProps<T>) {
  const [open, setOpen] = useState(false);

  const results = useMemo(() => {
    if (!value.trim()) return items.slice(0, 8);
    return findSimilar(value, items, getLabel, 0.3)
      .slice(0, 8)
      .map((m) => m.item);
  }, [value, items, getLabel]);

  const exactMatch = results.some((item) => getLabel(item).trim().toLowerCase() === value.trim().toLowerCase());

  return (
    <div className="relative">
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <input
          className="w-full rounded-lg border border-slate-300 pl-8 pr-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onQueryChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
        />
      </div>

      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {results.map((item) => (
            <button
              key={getId(item)}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm hover:bg-slate-50"
            >
              <span className="text-slate-800">{getLabel(item)}</span>
              {getSubLabel && <span className="text-xs text-slate-400">{getSubLabel(item)}</span>}
            </button>
          ))}
          {results.length === 0 && <p className="px-3 py-3 text-xs text-slate-400">Không tìm thấy trong database.</p>}
          {onCreateNew && value.trim() && !exactMatch && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onCreateNew(value.trim());
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2.5 text-left text-sm text-indigo-600 hover:bg-indigo-50"
            >
              <Plus size={14} />
              {createLabel} &ldquo;{value.trim()}&rdquo;
            </button>
          )}
        </div>
      )}
    </div>
  );
}
