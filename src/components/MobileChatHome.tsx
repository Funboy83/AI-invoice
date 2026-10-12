"use client";

import { Bot, Send, Sparkles } from "lucide-react";
import { useAiChat, QUICK_ACTIONS } from "@/lib/useAiChat";
import { useAppAuth } from "@/lib/useAppAuth";
import ChatThread from "./ChatThread";

/**
 * Full-screen AI chat used as the mobile home tab — the primary interface on iPhone. Rendered only inside
 * RequireAuth (layout.tsx), so it can assume it's always authorized.
 */
export default function MobileChatHome() {
  const { email, signOut } = useAppAuth();
  const { thread, input, setInput, send, busy } = useAiChat();

  const showQuickActions = thread.length === 0;

  return (
    // bottom offset must match BottomNav's height (3.25rem) so the input bar isn't covered by it
    <div className="md:hidden print:hidden fixed inset-x-0 top-0 bottom-[calc(3.25rem+env(safe-area-inset-bottom))] z-30 flex flex-col bg-white pt-[env(safe-area-inset-top)]">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-white">
            <Bot size={18} />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">AI Secretary</p>
            <p className="text-[11px] text-slate-500">Hôm nay bạn muốn làm gì?</p>
          </div>
        </div>
        <button onClick={() => signOut()} title={email ?? undefined} className="px-2 py-2 text-xs text-slate-400 active:text-slate-700">
          Đăng xuất
        </button>
      </div>

      <ChatThread variant="mobile">
        {showQuickActions && (
          <div className="flex flex-wrap gap-2 pt-2">
            {QUICK_ACTIONS.map((qa) => (
              <button
                key={qa}
                onClick={() => setInput(qa)}
                className="rounded-full border border-slate-300 px-3.5 py-2 text-sm text-slate-700 active:bg-slate-100"
              >
                {qa.trim()}
              </button>
            ))}
          </div>
        )}
      </ChatThread>

      <div className="shrink-0 border-t border-slate-200 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={3}
            placeholder="Dán tin nhắn khách hàng hoặc nhập yêu cầu..."
            className="min-w-0 flex-1 resize-none rounded-2xl border border-slate-300 px-4 py-3 text-base leading-snug focus:outline-none focus:ring-2 focus:ring-indigo-500 max-h-40 min-h-[6rem]"
          />
          <button
            onClick={() => send()}
            disabled={!input.trim()}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white disabled:opacity-40 active:bg-indigo-700"
            aria-label="Send"
          >
            {busy ? <Sparkles size={20} className="animate-pulse" /> : <Send size={20} />}
          </button>
        </div>
      </div>
    </div>
  );
}
