"use client";

import { useRef, useEffect, useState } from "react";
import { Bot, Send, X, Sparkles, Loader2 } from "lucide-react";
import clsx from "clsx";
import { useAiChat, actionSummary } from "@/lib/useAiChat";

/** Desktop-only floating AI chat drawer. On mobile the AI is the full-screen home tab instead (see MobileChatHome). */
export default function ChatPanel() {
  const [open, setOpen] = useState(false);
  const { messages, input, setInput, loading, send } = useAiChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="hidden md:flex fixed bottom-6 right-6 z-40 items-center gap-2 rounded-full bg-indigo-600 px-5 py-3 text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-700 transition-colors"
        >
          <Sparkles size={18} />
          <span className="text-sm font-medium">Ask AI</span>
        </button>
      )}

      <div
        className={clsx(
          "hidden md:flex fixed inset-y-0 right-0 z-50 w-full max-w-sm bg-white border-l border-slate-200 shadow-2xl flex-col transition-transform duration-200",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-white">
              <Bot size={16} />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">AI Secretary</p>
              <p className="text-[11px] text-slate-500">Invoices · Products · Customers</p>
            </div>
          </div>
          <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.map((m, i) => (
            <div key={i} className={clsx("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={clsx(
                  "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap leading-relaxed",
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
          {loading && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl bg-slate-100 px-3.5 py-2.5 text-sm text-slate-500">
                <Loader2 size={14} className="animate-spin" /> đang xử lý…
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="vd: Tạo invoice cho Hoa Lee 10 thùng milo 29"
              className="flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 max-h-28"
            />
            <button
              onClick={() => send()}
              disabled={loading || !input.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white disabled:opacity-40 hover:bg-indigo-700"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

