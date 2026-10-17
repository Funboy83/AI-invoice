"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, FileText, FileStack, Boxes, Users, ShoppingCart } from "lucide-react";
import clsx from "clsx";

// Each section has its own color so it is easy to tell apart at a glance.
const links = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, active: "bg-indigo-50 text-indigo-700", iconColor: "text-indigo-500" },
  { href: "/invoices", label: "Invoices", icon: FileText, active: "bg-sky-50 text-sky-700", iconColor: "text-sky-500" },
  { href: "/custom-invoices", label: "Custom Invoice", icon: FileStack, active: "bg-violet-50 text-violet-700", iconColor: "text-violet-500" },
  { href: "/products", label: "Products", icon: Boxes, active: "bg-amber-50 text-amber-700", iconColor: "text-amber-500" },
  { href: "/customers", label: "Customers", icon: Users, active: "bg-emerald-50 text-emerald-700", iconColor: "text-emerald-500" },
  { href: "/purchases", label: "Buy from vendor", icon: ShoppingCart, active: "bg-rose-50 text-rose-700", iconColor: "text-rose-500", also: "/vendors" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex print:hidden w-56 shrink-0 border-r border-slate-200 bg-white flex-col">
      <div className="px-5 py-5 border-b border-slate-200 flex items-center gap-3">
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-indigo-500 to-sky-500 text-white flex items-center justify-center font-bold shadow-sm">
          AI
        </div>
        <div>
          <p className="text-lg font-semibold text-slate-900 leading-tight">Invoice AI</p>
          <p className="text-xs text-slate-500">Virtual secretary</p>
        </div>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {links.map(({ href, label, icon: Icon, active: activeClass, iconColor, also }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href) || (!!also && pathname.startsWith(also));
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active ? activeClass : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              )}
            >
              <Icon size={17} className={iconColor} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="px-5 py-4 text-[11px] text-slate-400 border-t border-slate-200">
        Data synced with Firestore
      </div>
    </aside>
  );
}
