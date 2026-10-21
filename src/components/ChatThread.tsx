"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, ArrowUpRight, CheckCheck, CornerDownRight, HelpCircle, Loader2, RotateCcw, WifiOff } from "lucide-react";
import clsx from "clsx";
import { CHAT_WELCOME, actionSummary, followUpsFor, useAiChat, type ThreadItem } from "@/lib/useAiChat";
import ChatMarkdown from "./ChatMarkdown";
import { splitSuggestions } from "@/lib/chat/markdown";
import { useLang } from "@/lib/useLang";
import { translateChatLink } from "@/lib/chat/linkLabels";

/** Small status line under one of her messages: sending → accepted → running → (waiting / failed). */
function StatusLine({ item, mobile }: { item: ThreadItem; mobile: boolean }) {
  const { resend, dismissPending } = useAiChat();
  const { t } = useLang();
  const size = mobile ? "text-xs" : "text-[11px]";

  if (item.sendError && item.requestId) {
    return (
      <div className={clsx("mt-1 flex flex-col items-end gap-1", size)}>
        <span className="flex items-start gap-1 text-red-600 text-right">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {t(item.sendError)}
        </span>
        <span className="flex gap-3">
          {/* Same requestId is reused, so resending can never create a second copy of the request. */}
          {item.canResend && (
            <button onClick={() => resend(item.requestId!)} className="font-medium text-indigo-600 py-1">
              {t("Resend")}
            </button>
          )}
          <button onClick={() => dismissPending(item.requestId!)} className="text-slate-500 py-1">
            {t("Remove")}
          </button>
        </span>
      </div>
    );
  }
  if (item.status === "sending") {
    return (
      <p className={clsx("mt-1 flex items-center justify-end gap-1 text-slate-500", size)}>
        <Loader2 size={12} className="animate-spin" /> {t("Sending…")}
      </p>
    );
  }
  if (item.status === "accepted") {
    return (
      <p className={clsx("mt-1 flex items-center justify-end gap-1 text-slate-500", size)}>
        <CheckCheck size={12} /> {t("Received — waiting to start")}
      </p>
    );
  }
  if (item.status === "running") {
    const done = item.job?.actions.length ?? 0;
    return (
      <div className={clsx("mt-1 text-right text-slate-500", size)}>
        <p className="flex items-center justify-end gap-1">
          <Loader2 size={12} className="animate-spin" /> {done > 0 ? t("Working · {done} steps done", { done }) : t("Working…")}
        </p>
        <p className="text-slate-400">{t("You can leave the app — the work keeps going.")}</p>
      </div>
    );
  }
  if (item.status === "failed") {
    return <p className={clsx("mt-1 text-right text-red-600", size)}>{t("Not finished")}</p>;
  }
  return null;
}

/** The conversation itself (restored from Firestore) with per-request status. Shared by the desktop drawer and mobile home. */
export default function ChatThread({ variant, scrollKey, children }: { variant: "desktop" | "mobile"; scrollKey?: unknown; children?: ReactNode }) {
  const { thread, retryJob, online, loadError, notice, send, setInput, busy } = useAiChat();
  const mobile = variant === "mobile";
  const { t, lang } = useLang();
  const scrollRef = useRef<HTMLDivElement>(null);
  const last = thread[thread.length - 1];
  // "Xem tiếp" buttons only under the newest finished answer, and only when nothing else is running: the AI's own
  // suggested next questions (tap = ask), or else fixed next steps for what was just done (tap = fill the box).
  const showFollowUps = last && last.role === "assistant" && !last.awaitingAnswer && last.kind !== "error" && !busy;
  const aiSuggestions = showFollowUps ? splitSuggestions(last.content).suggestions : [];
  const followUps =
    aiSuggestions.length > 0 ? aiSuggestions.map((q) => ({ label: q, text: q, send: true })) : showFollowUps ? followUpsFor(last.actions).map((f) => ({ ...f, label: t(f.label), text: t(f.text) })) : [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [thread.length, last?.status, last?.content, scrollKey]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
      {!online && (
        <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <WifiOff size={14} /> {t("Offline — work already running keeps going, and the app updates itself when you are back online.")}
        </p>
      )}
      {loadError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{t(loadError)}</p>}
      {notice && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{t(notice)}</p>}

      {thread.length === 0 && !loadError && (
        <div className="flex justify-start">
          <div
            className={clsx(
              "max-w-[85%] rounded-2xl rounded-bl-sm bg-slate-100 text-slate-800 whitespace-pre-wrap leading-relaxed",
              mobile ? "px-4 py-3 text-[15px]" : "px-3.5 py-2.5 text-sm"
            )}
          >
            {t(CHAT_WELCOME)}
          </div>
        </div>
      )}

      {thread.map((m) => (
        <div key={m.key} className={clsx("flex flex-col", m.role === "user" ? "items-end" : "items-start")}>
          <div
            className={clsx(
              "min-w-0 rounded-2xl leading-relaxed",
              mobile ? "px-4 py-3 text-[15px]" : "px-3.5 py-2.5 text-sm",
              m.role === "user"
                ? "max-w-[85%] whitespace-pre-wrap bg-indigo-600 text-white rounded-br-sm"
                : m.kind === "error"
                  ? "max-w-[95%] bg-red-50 text-red-900 rounded-bl-sm"
                  : m.awaitingAnswer
                    ? "max-w-[95%] bg-amber-50 text-slate-800 ring-2 ring-amber-400 rounded-bl-sm"
                    : "max-w-[95%] bg-slate-100 text-slate-800 rounded-bl-sm"
            )}
          >
            {m.awaitingAnswer && (
              <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-amber-700">
                <HelpCircle size={13} /> {t("Needs your answer to continue")}
              </p>
            )}
            {m.role === "assistant" ? <ChatMarkdown content={splitSuggestions(m.content).body} mobile={mobile} /> : m.content}
            {m.choices && m.choices.length > 0 && (
              // Tap to answer instead of typing: the tapped text is sent as her reply.
              <div className="mt-3 flex flex-col items-stretch gap-2">
                {m.choices.map((c) => (
                  <button
                    key={c}
                    onClick={() => send(c)}
                    disabled={busy}
                    className={clsx(
                      "rounded-xl border border-amber-300 bg-white text-left font-medium text-slate-800 hover:bg-amber-50 active:bg-amber-100 disabled:opacity-50",
                      mobile ? "px-3.5 py-2.5 text-[15px]" : "px-3 py-2 text-sm"
                    )}
                  >
                    {c}
                  </button>
                ))}
                <p className={clsx("text-slate-500", mobile ? "text-xs" : "text-[11px]")}>{t("Or type a different answer below.")}</p>
              </div>
            )}
            {m.links && m.links.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {m.links.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className={clsx(
                      "flex items-center gap-1 rounded-full bg-white border border-indigo-200 font-medium text-indigo-700 hover:bg-indigo-50 active:bg-indigo-100",
                      mobile ? "px-3 py-1.5 text-sm" : "px-2.5 py-1 text-xs"
                    )}
                  >
                    {translateChatLink(l.label, lang)} <ArrowUpRight size={mobile ? 14 : 12} />
                  </Link>
                ))}
              </div>
            )}
            {m.actions && m.actions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {m.actions.map((a, idx) => (
                  <span key={idx} className="rounded-full bg-white/70 border border-slate-300 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                    {actionSummary(a.tool, a.result, t)}
                  </span>
                ))}
              </div>
            )}
            {m.retryJobId && (
              <button
                onClick={() => retryJob(m.retryJobId!)}
                className="mt-3 flex items-center gap-1.5 rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white active:bg-red-700"
              >
                <RotateCcw size={14} /> {t("Try again")}
              </button>
            )}
          </div>
          {m.role === "user" && <StatusLine item={m} mobile={mobile} />}
        </div>
      ))}

      {followUps.length > 0 && (
        <div className="flex flex-col items-start gap-2">
          <p className={clsx("text-slate-500", mobile ? "text-sm" : "text-xs")}>{t("Next:")}</p>
          {followUps.map((f) => (
            <button
              key={f.label}
              onClick={() => (f.send ? send(f.text) : setInput(f.text))}
              className={clsx(
                "flex max-w-full items-center gap-2 rounded-xl border border-slate-300 bg-white text-left text-slate-800 hover:bg-slate-50 active:bg-slate-100",
                mobile ? "px-3.5 py-2.5 text-[15px]" : "px-3 py-1.5 text-sm"
              )}
            >
              <CornerDownRight size={mobile ? 16 : 14} className="shrink-0 text-slate-400" />
              {f.label}
            </button>
          ))}
        </div>
      )}

      {children}
    </div>
  );
}
