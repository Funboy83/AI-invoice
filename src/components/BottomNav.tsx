"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, FileText, FileStack, Users, Boxes, ShoppingCart } from "lucide-react";
import clsx from "clsx";
import { useT } from "@/lib/useLang";

// Same per-section colors as the desktop sidebar; the active tab lights up in its own color.
const tabs = [
  { href: "/", label: "AI", icon: Sparkles, active: "text-indigo-600", pill: "bg-indigo-100" },
  { href: "/invoices", label: "Invoices", icon: FileText, active: "text-sky-600", pill: "bg-sky-100" },
  { href: "/custom-invoices", label: "Custom Invoice", icon: FileStack, active: "text-violet-600", pill: "bg-violet-100" },
  { href: "/customers", label: "Customers", icon: Users, active: "text-emerald-600", pill: "bg-emerald-100" },
  { href: "/products", label: "Products", icon: Boxes, active: "text-amber-600", pill: "bg-amber-100" },
  { href: "/purchases", label: "Buy", icon: ShoppingCart, active: "text-rose-600", pill: "bg-rose-100", also: "/vendors" },
];

export default function BottomNav() {
  const pathname = usePathname();
  const t = useT();

  return (
    <nav className="md:hidden print:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-stretch">
        {tabs.map(({ href, label, icon: Icon, active: activeClass, pill, also }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href) || (!!also && pathname.startsWith(also));
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[3.25rem] text-[11px] leading-tight text-center font-medium",
                active ? activeClass : "text-slate-500"
              )}
            >
              <span className={clsx("rounded-full px-3 py-0.5", active && pill)}>
                <Icon size={20} />
              </span>
              {t(label)}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
