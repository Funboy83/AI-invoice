"use client";

import { useEffect, useRef } from "react";
import { Bot, Send, Loader2, Sparkles } from "lucide-react";
import clsx from "clsx";
import { useAiChat, actionSummary, QUICK_ACTIONS } from "@/lib/useAiChat";

/** Full-screen AI chat used as the mobile home tab — the primary interface on iPhone. */
export default function MobileChatHome() {
  const { messages, input, setInput, loading, send } = useAiChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const showQuickActions = messages.length <= 1;

  return (
    <div className="md:hidden fixed inset-0 z-30 flex flex-col bg-white pt-[env(safe-area-inset-top)]">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-white">
          <Bot size={18} />
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-900">AI Secretary</p>
          <p className="text-[11px] text-slate-500">Hôm nay bạn muốn làm gì?</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((m, i) => (
          <div key={i} className={clsx("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={clsx(
                "max-w-[85%] rounded-2xl px-4 py-3 text-[15px] whitespace-pre-wrap leading-relaxed",
                m.role === "user" ? "bg-indigo-600 text-white rounded-br-sm" : "bg-slate-100 text-slate-800 rounded-bl-sm"
              )}
            >
              {m.content}
              {m.actions && m.actions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {m.actions.map((a, idx) => (
                    <span
                      key={idx}
                      className="rounded-full bg-white/70 border border-slate-300 px-2 py-0.5 text-[10px] font-medium text-slate-600"
                    >
                      {actionSummary(a.tool, a.result)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

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

        {loading && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-500">
              <Loader2 size={14} className="animate-spin" /> đang xử lý…
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-slate-200 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={1}
            placeholder="Dán tin nhắn khách hàng hoặc nhập yêu cầu..."
            className="flex-1 resize-none rounded-2xl border border-slate-300 px-4 py-3 text-base leading-snug focus:outline-none focus:ring-2 focus:ring-indigo-500 max-h-40 min-h-[3rem]"
          />
          <button
            onClick={() => send()}
            disabled={loading || !input.trim()}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white disabled:opacity-40 active:bg-indigo-700"
            aria-label="Send"
          >
            {loading ? <Sparkles size={20} className="animate-pulse" /> : <Send size={20} />}
          </button>
        </div>
      </div>
    </div>
  );
}
