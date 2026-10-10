"use client";

import { useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAppAuth } from "@/lib/useAppAuth";
import { openChatAfterSignIn } from "./ChatPanel";

/** Sign-in screen shown by RequireAuth in front of both business pages and the chat UI. */
export default function ChatSignIn({ compact = false }: { compact?: boolean }) {
  const { signIn } = useAppAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    const err = await signIn(email, password);
    setError(err);
    setBusy(false);
    if (!err) {
      // Land on the AI chat after logging in: "/" is the full-screen chat on phones, and the drawer opens on desktop.
      openChatAfterSignIn();
      router.replace("/");
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-1 flex-col justify-center gap-3 px-6 py-8">
      <p className={compact ? "text-sm text-slate-600" : "text-[15px] text-slate-600"}>
        Đăng nhập để dùng trợ lý AI. Cuộc trò chuyện của bạn được lưu riêng, đóng app rồi mở lại vẫn thấy.
      </p>
      <input
        type="email"
        autoComplete="username"
        inputMode="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        className="rounded-xl border border-slate-300 px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      <input
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Mật khẩu"
        className="rounded-xl border border-slate-300 px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy || !email.trim() || !password}
        className="flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-base font-medium text-white disabled:opacity-40 active:bg-indigo-700"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
        Đăng nhập
      </button>
    </form>
  );
}
