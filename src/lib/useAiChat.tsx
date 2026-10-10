"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "./firebase";
import { useAppAuth, isPermissionDenied } from "./useAppAuth";
import type { ChatMessageDoc, ClientJobStatus, JobView } from "./chat/types";
import { cleanChoices, isSafeChatHref, type ChatLink } from "./chat/links";

/** One row in the conversation, as the UI draws it. */
export interface ThreadItem {
  key: string;
  role: "user" | "assistant";
  content: string;
  /** Firestore message order; undefined for a message the server hasn't stored yet. */
  order?: number;
  status?: ClientJobStatus;
  job?: JobView;
  requestId?: string;
  /** Local-only send problem for a message the server hasn't accepted. */
  sendError?: string;
  /** False when the server rejected the message outright (resending would fail the same way). */
  canResend?: boolean;
  /** Assistant question the AI is still waiting on. */
  awaitingAnswer?: boolean;
  kind?: ChatMessageDoc["kind"];
  actions?: { tool: string; result: unknown }[];
  /** Shortcut buttons to the records this reply is about. */
  links?: ChatLink[];
  /** Tap-to-answer buttons for a question she hasn't answered yet. */
  choices?: string[];
  /** Failed job that can be retried from the checkpoint. */
  retryJobId?: string;
}

interface PendingSend {
  requestId: string;
  content: string;
  /** sending: request in flight · accepted: server said 202 (waiting for the transcript to show it) · unsent/rejected: needs her action */
  state: "sending" | "accepted" | "unsent" | "rejected";
  error?: string;
  createdAt: number;
}

interface AiChat {
  thread: ThreadItem[];
  input: string;
  setInput(v: string): void;
  send(text?: string): Promise<void>;
  resend(requestId: string): Promise<void>;
  dismissPending(requestId: string): void;
  retryJob(jobId: string): Promise<void>;
  /** Some request is accepted/running — she may leave; it keeps going. */
  busy: boolean;
  online: boolean;
  /** Set when the conversation can't be loaded (network/server error reading it — authorization is RequireAuth's job). */
  loadError: string | null;
  notice: string | null;
}

const WELCOME =
  "Chào bạn! Mình là trợ lý AI của cửa hàng — bạn có thể dán tin nhắn đặt hàng của khách, hỏi công nợ, tìm invoice, hoặc nhờ mình sửa invoice. Có gì mình sẽ hỏi lại nếu chưa rõ nhé.";

const Ctx = createContext<AiChat | null>(null);

const newRequestId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

const storageKey = (uid: string) => `aiChatPending:v1:${uid}`;
function loadPending(uid: string): PendingSend[] {
  try {
    const raw = window.localStorage.getItem(storageKey(uid));
    const list = raw ? (JSON.parse(raw) as PendingSend[]) : [];
    // A page that closed mid-request doesn't know if the server got it — show it as unsent; resending is duplicate-safe.
    return list.map((p) => (p.state === "sending" ? { ...p, state: "unsent" as const, error: UNSENT_TEXT } : p));
  } catch {
    return [];
  }
}
function savePending(uid: string, list: PendingSend[]) {
  try {
    window.localStorage.setItem(storageKey(uid), JSON.stringify(list));
  } catch {
    /* storage unavailable (private mode) — pending messages just won't survive a reload */
  }
}

const UNSENT_TEXT = "Chưa gửi được (có thể mất kết nối). Bấm Gửi lại — tin nhắn sẽ không bị gửi hai lần.";
const RESUME_POLL_MS = 30_000;

/**
 * Chat-transcript state. Rendered only inside RequireAuth (see layout.tsx), so `uid`/`conversationId` from
 * useAppAuth() are always present here — this component is never mounted while signed out, denied, or loading.
 */
export function AiChatProvider({ children }: { children: ReactNode }) {
  const { uid, conversationId, authedFetch, notifyPossibleRevocation } = useAppAuth();
  const [transcript, setTranscript] = useState<{ conversationId: string; docs: ChatMessageDoc[] } | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [pendingState, setPendingState] = useState<{ uid: string; list: PendingSend[] } | null>(null);
  const [input, setInput] = useState("");
  const [online, setOnline] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const knownRequests = useRef<Set<string>>(new Set());

  /* ---- connectivity ---- */
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  /* ---- live transcript: restores everything on reload / reopen, and streams job progress ---- */
  useEffect(() => {
    if (!conversationId) return;
    const q = query(collection(db, "chatConversations", conversationId, "messages"), orderBy("order", "desc"), limit(100));
    return onSnapshot(
      q,
      (snap) => {
        const docs = snap.docs.map((d) => d.data() as ChatMessageDoc).reverse();
        knownRequests.current = new Set(docs.map((d) => d.requestId).filter((r): r is string => !!r));
        setSnapshotError(null);
        setTranscript({ conversationId, docs });
      },
      (err) => {
        console.error("[chat] transcript listener", err);
        setSnapshotError("Không đọc được cuộc trò chuyện. Thử tải lại trang.");
        if (isPermissionDenied(err)) notifyPossibleRevocation();
      }
    );
  }, [conversationId, notifyPossibleRevocation]);

  const docs = transcript && transcript.conversationId === conversationId ? transcript.docs : null;

  /* ---- messages not yet accepted by the server (kept in localStorage so a reload doesn't lose them) ---- */
  useEffect(() => {
    if (!uid) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from localStorage per account
    setPendingState({ uid, list: loadPending(uid) });
  }, [uid]);
  const storedPending = useMemo(() => (pendingState && pendingState.uid === uid ? pendingState.list : []), [pendingState, uid]);
  // Once the transcript shows a request, the server has it — the local copy is redundant (and pruned on the next write).
  const pending = useMemo(() => {
    const known = new Set((docs ?? []).map((d) => d.requestId));
    return storedPending.filter((p) => !known.has(p.requestId));
  }, [storedPending, docs]);

  const updatePending = useCallback(
    (fn: (list: PendingSend[]) => PendingSend[]) => {
      if (!uid) return;
      setPendingState((prev) => {
        const next = fn(prev && prev.uid === uid ? prev.list : []).filter((p) => !knownRequests.current.has(p.requestId));
        savePending(uid, next);
        return { uid, list: next };
      });
    },
    [uid]
  );

  /* ---- reconnect to work in progress: nudge unfinished jobs so a dead worker never strands a request ---- */
  const activeJobIds = useMemo(
    () => (docs ?? []).filter((d) => d.job && (d.job.status === "accepted" || d.job.status === "running")).map((d) => d.job!.id),
    [docs]
  );
  const activeKey = activeJobIds.join(",");
  useEffect(() => {
    if (!activeKey) return;
    const ids = activeKey.split(",");
    const nudge = () => {
      if (document.visibilityState !== "visible") return;
      for (const id of ids) authedFetch(`/api/chat/jobs/${id}/resume`, { method: "POST" }).catch(() => {});
    };
    nudge(); // right away: covers "opened the app and a job is stuck"
    const timer = window.setInterval(nudge, RESUME_POLL_MS);
    document.addEventListener("visibilitychange", nudge);
    window.addEventListener("online", nudge);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", nudge);
      window.removeEventListener("online", nudge);
    };
  }, [activeKey, authedFetch]);

  /* ---- sending ---- */
  const submit = useCallback(
    async (p: PendingSend) => {
      updatePending((list) => list.map((x) => (x.requestId === p.requestId ? { ...x, state: "sending", error: undefined } : x)));
      try {
        const res = await authedFetch("/api/chat", { method: "POST", body: JSON.stringify({ requestId: p.requestId, content: p.content }) });
        if (res.ok) {
          updatePending((list) => list.map((x) => (x.requestId === p.requestId ? { ...x, state: "accepted" } : x)));
          return;
        }
        const data = await res.json().catch(() => ({}));
        const message: string = data.error ?? "Có lỗi xảy ra.";
        if (res.status === 401 || res.status === 403) notifyPossibleRevocation();
        // 4xx (except busy/timeout) will fail again identically; anything else may succeed if she retries.
        const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
        updatePending((list) =>
          list.map((x) => (x.requestId === p.requestId ? { ...x, state: permanent ? "rejected" : "unsent", error: message } : x))
        );
      } catch {
        updatePending((list) => list.map((x) => (x.requestId === p.requestId ? { ...x, state: "unsent", error: UNSENT_TEXT } : x)));
      }
    },
    [authedFetch, updatePending, notifyPossibleRevocation]
  );

  const send = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim();
      if (!content || !uid) return;
      const p: PendingSend = { requestId: newRequestId(), content, state: "sending", createdAt: Date.now() };
      updatePending((list) => [...list, p]);
      setInput("");
      await submit(p);
    },
    [input, uid, submit, updatePending]
  );

  const resend = useCallback(
    async (requestId: string) => {
      const p = pending.find((x) => x.requestId === requestId);
      if (p) await submit(p); // same requestId → the server treats it as the same request
    },
    [pending, submit]
  );

  const dismissPending = useCallback((requestId: string) => updatePending((list) => list.filter((x) => x.requestId !== requestId)), [updatePending]);

  const retryJob = useCallback(
    async (jobId: string) => {
      try {
        const res = await authedFetch(`/api/chat/jobs/${jobId}/retry`, { method: "POST" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setNotice(data.error ?? "Không thử lại được.");
          if (res.status === 401 || res.status === 403) notifyPossibleRevocation();
        }
      } catch {
        setNotice("Không kết nối được máy chủ — thử lại sau nhé.");
      }
    },
    [authedFetch, notifyPossibleRevocation]
  );
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /* ---- what to draw ---- */
  const thread = useMemo<ThreadItem[]>(() => {
    const items: ThreadItem[] = [];
    const list = docs ?? [];
    const lastUserOrder = list.reduce((m, d) => (d.role === "user" ? Math.max(m, d.order) : m), -1);
    const lastSeq = list.reduce((m, d) => Math.max(m, d.jobSeq), 0);
    const jobById = new Map(list.filter((d) => d.job).map((d) => [d.job!.id, d.job!]));
    for (const d of list) {
      if (d.role === "user") {
        items.push({ key: `m${d.order}`, role: "user", content: d.content, order: d.order, status: d.job?.status, job: d.job, requestId: d.requestId });
      } else {
        items.push({
          key: `m${d.order}`,
          role: "assistant",
          content: d.content,
          order: d.order,
          kind: d.kind,
          actions: d.actions,
          links: Array.isArray(d.links) ? d.links.filter((l) => isSafeChatHref(l?.href) && typeof l.label === "string") : undefined,
          awaitingAnswer: d.kind === "question" && d.order > lastUserOrder,
          choices: d.kind === "question" && d.order > lastUserOrder ? cleanChoices(d.choices) : undefined,
          // Only the newest job can be retried (older ones would run out of order).
          retryJobId: d.kind === "error" && d.jobSeq === lastSeq && jobById.get(d.jobId)?.failure?.retryable !== false ? d.jobId : undefined,
        });
      }
    }
    for (const p of pending) {
      items.push({
        key: `p${p.requestId}`,
        role: "user",
        content: p.content,
        requestId: p.requestId,
        status: p.state === "accepted" ? "accepted" : p.state === "sending" ? "sending" : undefined,
        sendError: p.state === "unsent" || p.state === "rejected" ? p.error : undefined,
        canResend: p.state === "unsent",
      });
    }
    return items;
  }, [docs, pending]);

  const busy = activeJobIds.length > 0 || pending.some((p) => p.state === "sending" || p.state === "accepted");

  const value: AiChat = {
    thread,
    input,
    setInput,
    send,
    resend,
    dismissPending,
    retryJob,
    busy,
    online,
    loadError: snapshotError,
    notice,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Shared chat state/logic used by both the desktop drawer and the mobile full-screen home. */
export function useAiChat(): AiChat {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAiChat must be used inside <AiChatProvider>");
  return ctx;
}

export const CHAT_WELCOME = WELCOME;

export function actionSummary(tool: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  const status = typeof r.status === "string" ? r.status : undefined;
  if (status === "awaiting_user") return `❓ Cần bạn trả lời`;
  if (status === "needs_confirmation" || status === "needs_new_product" || status === "needs_new_customer" || status === "needs_more_info") {
    return `⚠️ ${tool} — cần bạn xác nhận`;
  }
  if (status === "error") return `✕ ${tool} lỗi`;
  if (tool === "createInvoiceDraft" && status === "created") return `✓ Đã tạo invoice nháp`;
  if (tool === "createProduct" && status === "created") return `✓ Đã thêm sản phẩm`;
  if (tool === "createCustomer" && status === "created") return `✓ Đã thêm khách hàng`;
  if (tool === "recordPayment") return `✓ Đã ghi nhận thanh toán`;
  if (tool === "finalizeInvoice") return `✓ Invoice đã hoàn tất`;
  if (tool.startsWith("update") || tool.startsWith("add") || tool.startsWith("remove")) return `✓ ${tool} (đã ghi log)`;
  return `✓ ${tool}`;
}

export const QUICK_ACTIONS = [
  "Tạo invoice cho ",
  "Tìm invoice ",
  "Khách này còn nợ bao nhiêu?",
  "Invoice nào chưa thanh toán?",
  "Tìm khách hàng ",
  "Tìm sản phẩm ",
];

/**
 * Suggested next step after a reply, like KiotViet's quick buttons. `send: true` sends right away (only for
 * questions that just read data); everything else is put in the box so she can check or finish it before sending.
 */
export interface FollowUp {
  label: string;
  text: string;
  send: boolean;
}

const INVOICE_EDIT_TOOLS = new Set(["createInvoiceDraft", "copyInvoice", "addInvoiceItem", "updateInvoiceItem", "removeInvoiceItem"]);

export function followUpsFor(actions: { tool: string; result: unknown }[] | undefined): FollowUp[] {
  const ok = (actions ?? []).filter((a) => {
    const st = (a.result as { status?: unknown } | null)?.status;
    return st !== "error" && st !== "needs_confirmation" && st !== "needs_more_info" && st !== "awaiting_user";
  });
  const last = ok[ok.length - 1]?.tool;
  if (!last) return [];
  if (INVOICE_EDIT_TOOLS.has(last)) {
    return [
      { label: "Hoàn tất invoice này", text: "Hoàn tất invoice này", send: false },
      { label: "Thêm món", text: "Thêm ", send: false },
      { label: "Khách trả tiền", text: "Khách trả ", send: false },
    ];
  }
  if (last === "finalizeInvoice") {
    return [
      { label: "Khách trả tiền", text: "Khách trả ", send: false },
      { label: "Khách này còn nợ bao nhiêu?", text: "Khách này còn nợ bao nhiêu?", send: true },
    ];
  }
  if (last === "recordPayment") return [{ label: "Khách này còn nợ bao nhiêu?", text: "Khách này còn nợ bao nhiêu?", send: true }];
  if (last === "getCustomerDebt") {
    return [
      { label: "Khách trả tiền", text: "Khách trả ", send: false },
      { label: "Tạo invoice cho khách này", text: "Tạo invoice cho khách này: ", send: false },
    ];
  }
  if (last === "getUnpaidInvoices") return [{ label: "Ai nợ nhiều nhất?", text: "Khách nào đang nợ nhiều nhất?", send: true }];
  if (last === "createCustomer" || last === "getCustomer" || last === "searchCustomer") {
    return [
      { label: "Tạo invoice cho khách này", text: "Tạo invoice cho khách này: ", send: false },
      { label: "Khách này còn nợ bao nhiêu?", text: "Khách này còn nợ bao nhiêu?", send: true },
    ];
  }
  return [];
}
