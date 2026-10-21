"use client";

import { type ReactNode } from "react";
import { Loader2, ShieldAlert, LogOut, AlertTriangle } from "lucide-react";
import { useAppAuth } from "@/lib/useAppAuth";
import ChatSignIn from "./ChatSignIn";
import { useT } from "@/lib/useLang";

/**
 * The single gate for both business pages and the chat UI. Children mount ONLY once authorized — so on
 * logout/account switch/access removal they unmount (not just hide), which is what actually detaches every
 * onSnapshot listener and clears every page's local state; nothing here needs to reset that by hand. Wrapping
 * the authorized branch in a key={uid} is extra insurance: even if a future change made "authorized" render
 * without passing through "loading" first, React would still fully remount rather than reuse stale state.
 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const { authState, uid, email, deniedReason, signOut, loadError } = useAppAuth();
  const t = useT();

  // RequireAuth sits directly inside <body className="flex">, alongside Sidebar/BottomNav (see layout.tsx), and
  // wraps <main className="flex-1 …"> — every branch below needs the SAME "flex-1 min-w-0" sizing that <main>
  // used to get directly from being body's flex child, or the page layout collapses.
  if (authState === "loading") {
    return (
      <div className="flex flex-1 min-w-0 items-center justify-center text-slate-400">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }

  if (authState === "signedOut") {
    return (
      <div className="flex flex-1 min-w-0 flex-col">
        <ChatSignIn />
      </div>
    );
  }

  if (authState === "denied") {
    return (
      <div className="flex flex-1 min-w-0 flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
          <ShieldAlert size={22} />
        </div>
        <div>
          <p className="text-base font-semibold text-slate-900">{t("No access")}</p>
          <p className="mt-1.5 max-w-xs text-sm text-slate-500">
            {deniedReason ? t(deniedReason) : t("This account has not been given access to the store yet.")}
          </p>
          {email && <p className="mt-1 text-xs text-slate-400">{email}</p>}
        </div>
        <button
          onClick={() => signOut()}
          className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <LogOut size={14} /> {t("Sign out / switch account")}
        </button>
      </div>
    );
  }

  // display:contents — a real DOM node (so key={uid} forces a remount on account switch) that doesn't itself
  // participate in the flex box model, so <main>/<ChatPanel> inside `children` still lay out as if they were
  // direct children of body, exactly as before RequireAuth existed.
  return (
    <div key={uid} className="contents">
      {loadError && (
        <div className="fixed inset-x-3 top-3 z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 shadow-lg print:hidden">
          <AlertTriangle size={18} className="shrink-0 text-red-600" />
          <p className="flex-1 text-sm text-red-800">{t(loadError)} {t("Check your internet, then tap Reload.")}</p>
          <button
            onClick={() => window.location.reload()}
            className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            {t("Reload")}
          </button>
        </div>
      )}
      {children}
    </div>
  );
}
