"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, FileText, FileStack, Users, Boxes } from "lucide-react";
import clsx from "clsx";

const tabs = [
  { href: "/", label: "AI", icon: Sparkles },
  { href: "/invoices", label: "Invoices", icon: FileText },
  { href: "/custom-invoices", label: "Custom Invoice", icon: FileStack },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/products", label: "Products", icon: Boxes },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="md:hidden print:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-stretch">
        {tabs.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[3.25rem] text-[11px] leading-tight text-center font-medium",
                active ? "text-indigo-600" : "text-slate-500"
              )}
            >
              <Icon size={20} />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
