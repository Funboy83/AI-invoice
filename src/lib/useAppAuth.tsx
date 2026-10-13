"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut as firebaseSignOut, type User } from "firebase/auth";
import { getClientAuth } from "./firebase";
import { setActiveStore } from "./store";
import { DEFAULT_STORE_ID, STORE_HEADER, isStoreId } from "./stores";

/** Remembers the last store picked on this device (a convenience only; the server checks access on every call). */
const STORE_STORAGE_KEY = "invoice-ai.store";
function readSavedStore(): string {
  try {
    const saved = window.localStorage.getItem(STORE_STORAGE_KEY);
    return isStoreId(saved) ? saved : DEFAULT_STORE_ID;
  } catch {
    return DEFAULT_STORE_ID;
  }
}

/**
 * The one authorization gate for the whole app: a Firebase Auth session AND current store membership (checked
 * live, server-side, via GET /api/session — see src/lib/server/auth.ts / membership.ts). Chat and every business
 * page are gated on the SAME state here, because in this app they are the same permission: an approved account
 * can chat AND read/act on the shared business data; anyone else gets neither. Business pages and the chat UI
 * (useAiChat.tsx) both consume this instead of touching Firebase Auth directly.
 */
export type AuthState = "loading" | "signedOut" | "denied" | "authorized";

interface AppAuth {
  authState: AuthState;
  uid: string | null;
  email: string | null;
  /** Set only in the "denied" state: why (not authorized, or the check itself failed — e.g. offline). */
  deniedReason: string | null;
  /** Only meaningful once authorized — which private chat conversation belongs to this account in this store. */
  conversationId: string | null;
  /**
   * The store everything on screen belongs to (src/lib/stores.ts). Every API call carries it, every page reads only
   * its data, and changing it remounts every page and the chat, so nothing from the previous store stays on screen.
   */
  storeId: string;
  setStoreId(storeId: string): void;
  signIn(email: string, password: string): Promise<string | null>;
  signOut(): Promise<void>;
  /** fetch with the current ID token attached; used for every authenticated API call. */
  authedFetch(url: string, init?: RequestInit): Promise<Response>;
  /**
   * Call when a live Firestore listener errors with permission-denied — a strong signal access may have just been
   * revoked. Triggers an immediate re-check instead of waiting for the slower background poll.
   */
  notifyPossibleRevocation(): void;
}

const Ctx = createContext<AppAuth | null>(null);

/** Belt-and-suspenders background re-check while authorized, independent of any listener noticing revocation. */
const REVOCATION_POLL_MS = 90_000;

export function AppAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  // Both tagged with the uid they were computed for, so a mid-flight check for a PREVIOUS uid can never be
  // mistaken for the current one's result (matters for account switching without an intermediate sign-out).
  const [session, setSession] = useState<{ uid: string; storeId: string; conversationId: string; email: string } | null>(null);
  const [denied, setDenied] = useState<{ uid: string; storeId: string; reason: string } | null>(null);
  // Starts unknown (the server render can't see this device's saved choice) so no page mounts before it's read.
  const [storeId, setStoreIdState] = useState<string | null>(null);

  useEffect(() => {
    const saved = readSavedStore();
    setActiveStore(saved);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of this device's saved store after mount
    setStoreIdState(saved);
  }, []);

  const setStoreId = useCallback((next: string) => {
    if (!isStoreId(next)) return;
    try {
      window.localStorage.setItem(STORE_STORAGE_KEY, next);
    } catch {
      // private mode etc. — the choice just won't be remembered next time
    }
    // Before the state change, so pages remounting for the new store already read the new store's collections.
    setActiveStore(next);
    setStoreIdState(next);
  }, []);
  const [checkTick, setCheckTick] = useState(0);

  const uid = user?.uid ?? null;

  useEffect(() => {
    return onAuthStateChanged(getClientAuth(), (u) => {
      setUser(u);
      setAuthReady(true);
    });
  }, []);

  const authedFetch = useCallback(
    async (url: string, init?: RequestInit) => {
      const token = await getClientAuth().currentUser?.getIdToken();
      return fetch(url, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          "Content-Type": "application/json",
          Authorization: `Bearer ${token ?? ""}`,
          [STORE_HEADER]: storeId ?? DEFAULT_STORE_ID,
        },
      });
    },
    [storeId]
  );

  useEffect(() => {
    if (!uid || !storeId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch("/api/session");
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) {
          setSession({ uid, storeId, conversationId: data.conversationId, email: data.email ?? "" });
          setDenied(null);
        } else {
          setSession(null);
          setDenied({ uid, storeId, reason: data.error ?? "Tài khoản này không có quyền truy cập." });
        }
      } catch {
        if (!cancelled) {
          setSession(null);
          setDenied({ uid, storeId, reason: "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uid, storeId, authedFetch, checkTick]);

  const recheck = useCallback(() => setCheckTick((t) => t + 1), []);

  // Retry automatically on reconnect / returning to the app, and periodically while authorized (revocation while
  // a tab sits open is also caught by Firestore listener errors — see notifyPossibleRevocation — this is the
  // fallback for when nothing happens to be actively listening at the moment access is removed).
  useEffect(() => {
    if (!uid) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    window.addEventListener("online", recheck);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(recheck, REVOCATION_POLL_MS);
    return () => {
      window.removeEventListener("online", recheck);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [uid, recheck]);

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      await signInWithEmailAndPassword(getClientAuth(), email.trim(), password);
      return null;
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code.includes("network")) return "Không có mạng — kiểm tra kết nối rồi thử lại.";
      if (code.includes("too-many-requests")) return "Thử quá nhiều lần — đợi một lúc rồi thử lại.";
      return "Email hoặc mật khẩu chưa đúng.";
    }
  }, []);

  const signOut = useCallback(async () => {
    await firebaseSignOut(getClientAuth());
    // onAuthStateChanged will fire with null and drive authState to "signedOut"; clear the rest right away too
    // so nothing briefly renders with a stale session while that propagates.
    setSession(null);
    setDenied(null);
  }, []);

  // A session/denial only counts for the uid AND store it was checked for, so after a store switch nothing renders
  // until the new store's access is confirmed.
  const sessionCurrent = session !== null && session.uid === uid && session.storeId === storeId;
  const deniedCurrent = denied !== null && denied.uid === uid && denied.storeId === storeId;
  const authState: AuthState = !authReady || !storeId
    ? "loading"
    : !user
      ? "signedOut"
      : sessionCurrent
        ? "authorized"
        : deniedCurrent
          ? "denied"
          : "loading"; // checking the (possibly new) uid's membership for this store

  const value: AppAuth = {
    authState,
    uid,
    email: sessionCurrent ? session.email : (user?.email ?? null),
    deniedReason: deniedCurrent ? denied.reason : null,
    conversationId: sessionCurrent ? session.conversationId : null,
    storeId: storeId ?? DEFAULT_STORE_ID,
    setStoreId,
    signIn,
    signOut,
    authedFetch,
    notifyPossibleRevocation: recheck,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppAuth(): AppAuth {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppAuth must be used inside <AppAuthProvider>");
  return ctx;
}

/** True for a Firestore error that means "the security rules no longer allow this" (as opposed to e.g. offline). */
export function isPermissionDenied(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "permission-denied";
}
