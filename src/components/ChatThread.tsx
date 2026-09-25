"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AlertCircle, CheckCheck, HelpCircle, Loader2, RotateCcw, WifiOff } from "lucide-react";
import clsx from "clsx";
import { CHAT_WELCOME, actionSummary, useAiChat, type ThreadItem } from "@/lib/useAiChat";

/** Small status line under one of her messages: sending → accepted → running → (waiting / failed). */
function StatusLine({ item, mobile }: { item: ThreadItem; mobile: boolean }) {
  const { resend, dismissPending } = useAiChat();
  const size = mobile ? "text-xs" : "text-[11px]";

  if (item.sendError && item.requestId) {
    return (
      <div className={clsx("mt-1 flex flex-col items-end gap-1", size)}>
        <span className="flex items-start gap-1 text-red-600 text-right">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {item.sendError}
        </span>
        <span className="flex gap-3">
          {/* Same requestId is reused, so resending can never create a second copy of the request. */}
          {item.canResend && (
            <button onClick={() => resend(item.requestId!)} className="font-medium text-indigo-600 py-1">
              Gửi lại
            </button>
          )}
          <button onClick={() => dismissPending(item.requestId!)} className="text-slate-500 py-1">
            Xóa
          </button>
        </span>
      </div>
    );
  }
  if (item.status === "sending") {
    return (
      <p className={clsx("mt-1 flex items-center justify-end gap-1 text-slate-500", size)}>
        <Loader2 size={12} className="animate-spin" /> Đang gửi…
      </p>
    );
  }
  if (item.status === "accepted") {
    return (
      <p className={clsx("mt-1 flex items-center justify-end gap-1 text-slate-500", size)}>
        <CheckCheck size={12} /> Đã nhận — đang chờ xử lý
      </p>
    );
  }
  if (item.status === "running") {
    const done = item.job?.actions.length ?? 0;
    return (
      <div className={clsx("mt-1 text-right text-slate-500", size)}>
        <p className="flex items-center justify-end gap-1">
          <Loader2 size={12} className="animate-spin" /> Đang xử lý{done > 0 ? ` · đã xong ${done} bước` : "…"}
        </p>
        <p className="text-slate-400">Bạn có thể thoát app — việc vẫn được tiếp tục.</p>
      </div>
    );
  }
  if (item.status === "failed") {
    return <p className={clsx("mt-1 text-right text-red-600", size)}>Chưa hoàn thành</p>;
  }
  return null;
}

/** The conversation itself (restored from Firestore) with per-request status. Shared by the desktop drawer and mobile home. */
export default function ChatThread({ variant, scrollKey, children }: { variant: "desktop" | "mobile"; scrollKey?: unknown; children?: ReactNode }) {
  const { thread, retryJob, online, loadError, notice } = useAiChat();
  const mobile = variant === "mobile";
  const scrollRef = useRef<HTMLDivElement>(null);
  const last = thread[thread.length - 1];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [thread.length, last?.status, last?.content, scrollKey]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
      {!online && (
        <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <WifiOff size={14} /> Đang mất kết nối — việc đang chạy vẫn tiếp tục, app sẽ tự cập nhật khi có mạng.
        </p>
      )}
      {loadError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}
      {notice && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{notice}</p>}

      {thread.length === 0 && !loadError && (
        <div className="flex justify-start">
          <div
            className={clsx(
              "max-w-[85%] rounded-2xl rounded-bl-sm bg-slate-100 text-slate-800 whitespace-pre-wrap leading-relaxed",
              mobile ? "px-4 py-3 text-[15px]" : "px-3.5 py-2.5 text-sm"
            )}
          >
            {CHAT_WELCOME}
          </div>
        </div>
      )}

      {thread.map((m) => (
        <div key={m.key} className={clsx("flex flex-col", m.role === "user" ? "items-end" : "items-start")}>
          <div
            className={clsx(
              "max-w-[85%] rounded-2xl whitespace-pre-wrap leading-relaxed",
              mobile ? "px-4 py-3 text-[15px]" : "px-3.5 py-2.5 text-sm",
              m.role === "user"
                ? "bg-indigo-600 text-white rounded-br-sm"
                : m.kind === "error"
                  ? "bg-red-50 text-red-900 rounded-bl-sm"
                  : m.awaitingAnswer
                    ? "bg-amber-50 text-slate-800 ring-2 ring-amber-400 rounded-bl-sm"
                    : "bg-slate-100 text-slate-800 rounded-bl-sm"
            )}
          >
            {m.awaitingAnswer && (
              <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-amber-700">
                <HelpCircle size={13} /> Cần bạn trả lời để tiếp tục
              </p>
            )}
            {m.content}
            {m.actions && m.actions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {m.actions.map((a, idx) => (
                  <span key={idx} className="rounded-full bg-white/70 border border-slate-300 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                    {actionSummary(a.tool, a.result)}
                  </span>
                ))}
              </div>
            )}
            {m.retryJobId && (
              <button
                onClick={() => retryJob(m.retryJobId!)}
                className="mt-3 flex items-center gap-1.5 rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white active:bg-red-700"
              >
                <RotateCcw size={14} /> Thử lại
              </button>
            )}
          </div>
          {m.role === "user" && <StatusLine item={m} mobile={mobile} />}
        </div>
      ))}

      {children}
    </div>
  );
}
