/** Shared (client + server) shapes for durable AI chat. Persisted in Firestore under chatConversations / chatJobs. */

/** fetch with an ID token attached — the shape useAppAuth().authedFetch exposes, reused by src/lib/businessApi.ts. */
export type AuthedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Server-side job lifecycle. The client adds a local "sending" state for a request the server hasn't accepted yet
 * (see ClientJobStatus). `waiting_for_input` means the AI asked a question and is paused until she answers.
 */
export type JobStatus = "accepted" | "running" | "waiting_for_input" | "completed" | "failed";
export type ClientJobStatus = "sending" | JobStatus;

/** Statuses after which a job does no more work on its own (the conversation queue moves on). */
export const TERMINAL_STATUSES: readonly JobStatus[] = ["waiting_for_input", "completed", "failed"];
export const isTerminalStatus = (s: JobStatus) => TERMINAL_STATUSES.includes(s);

export interface JobActionView {
  tool: string;
  /** The tool result's `status` field (created / needs_confirmation / error …), if it had one. */
  status?: string;
  mutating: boolean;
}

export interface JobFailureView {
  message: string;
  /** False for problems a retry cannot fix (missing API key, rejected request). */
  retryable: boolean;
}

/** Denormalised job state, mirrored onto the user's message doc so the UI needs a single subscription. */
export interface JobView {
  id: string;
  seq: number;
  status: JobStatus;
  attempts: number;
  /** Server clock (ms) of the last state change or heartbeat. */
  updatedAt: number;
  actions: JobActionView[];
  failure?: JobFailureView;
}

export type ChatMessageKind = "text" | "question" | "error";

export interface ChatMessageDoc {
  ownerUid: string;
  /** 2*seq for the user's message, 2*seq+1 for the reply to it — gives a stable causal order. */
  order: number;
  role: "user" | "assistant";
  content: string;
  jobId: string;
  jobSeq: number;
  createdAt: number;
  /** User messages: the client's idempotency key. */
  requestId?: string;
  /** User messages: live job state. */
  job?: JobView;
  /** Assistant messages. */
  kind?: ChatMessageKind;
  actions?: { tool: string; result: { status?: string } }[];
}

export const MAX_MESSAGE_CHARS = 8000;
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Doc ids sort lexicographically in `order`. */
export const orderId = (order: number) => String(order).padStart(8, "0");
export const conversationIdFor = (storeId: string, uid: string) => `${storeId}__${uid}`;
export const jobIdFor = (conversationId: string, seq: number) => `${conversationId}__j${String(seq).padStart(6, "0")}`;
