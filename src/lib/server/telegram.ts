import { timingSafeEqual } from "node:crypto";
import { getAdminDb } from "./firebaseAdmin";
import { memberByEmail } from "./membership";
import { HttpError, currentStoreId, type AuthedUser } from "./auth";
import { workerBaseUrl } from "./dispatch";
import { logJob } from "./jobLog";
import { acceptMessage, getReplyMessage, getReplyMessageBySeq, telegramConversationIdFor, type JobDoc, type JobOrigin } from "./chatJobs";
import { parseBlocks, parseInline, splitSuggestions, type Inline } from "@/lib/chat/markdown";
import { isSafeChatHref, type ChatLink } from "@/lib/chat/links";
import type { ChatMessageDoc } from "@/lib/chat/types";

/**
 * Telegram is just another chat window for the SAME AI secretary: a message from an allowed Telegram account becomes
 * a normal chat job (same tools, same rules, same database), and the saved reply is sent back with buttons.
 *
 * Off unless TELEGRAM_ENABLED=true and both TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are set. Who may use it:
 * TELEGRAM_ALLOWED_USERS = "telegramUserId:appLoginEmail,…" — each Telegram account is tied to an existing app member
 * (storeMembers), checked live on every message, so removing the member also cuts off their Telegram access.
 * Each Telegram account gets its own conversation; it never mixes with the in-app chat.
 */

export interface TelegramConfig {
  token: string;
  secret: string;
  /** Telegram user id → app login email (lower-case). */
  allowed: Map<number, string>;
}

export function telegramConfig(env: Record<string, string | undefined> = process.env): TelegramConfig | null {
  if (env.TELEGRAM_ENABLED?.trim().toLowerCase() !== "true") return null;
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!token || !secret) return null;
  return { token, secret, allowed: parseAllowedUsers(env.TELEGRAM_ALLOWED_USERS ?? "") };
}

/** "123:a@b.com, 456:c@d.com" → Map. Malformed entries are ignored (never widen access by accident). */
export function parseAllowedUsers(raw: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const entry of raw.split(/[,;\n]/)) {
    const m = /^\s*(\d{1,20})\s*:\s*([^\s:]+@[^\s:]+)\s*$/.exec(entry);
    if (m) out.set(Number(m[1]), m[2].toLowerCase());
  }
  return out;
}

/** Constant-time check of the X-Telegram-Bot-Api-Secret-Token header Telegram sends with every webhook call. */
export function secretMatches(given: string | null, expected: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------- Telegram API ------------------------------- */

/** Swappable for tests. */
export const telegramTransport = {
  async call(token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return res.json().catch(() => null);
  },
};

const tg = (cfg: TelegramConfig, method: string, body: Record<string, unknown>) => telegramTransport.call(cfg.token, method, body);

/* ------------------------------- formatting ------------------------------- */

const TELEGRAM_MAX_CHARS = 4096;
const SAFE_LIMIT = 3800;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Absolute https URL for an in-app path, or null when the app has no public https address (e.g. local dev). */
export function appUrl(path: string): string | null {
  const base = workerBaseUrl();
  if (!base || !base.startsWith("https://") || !isSafeChatHref(path)) return null;
  return `${base}${path}`;
}

function inlineHtml(parts: Inline[]): string {
  return parts
    .map((p) => {
      if (p.type === "bold") return `<b>${escapeHtml(p.text)}</b>`;
      if (p.type === "link") {
        const url = appUrl(p.href);
        return url ? `<a href="${escapeHtml(url)}">${escapeHtml(p.text)}</a>` : escapeHtml(p.text);
      }
      return escapeHtml(p.text);
    })
    .join("");
}

const plainCell = (cell: string) =>
  parseInline(cell)
    .map((p) => p.text)
    .join("");

/** Telegram can't draw tables: show them as a monospace block with padded columns. */
function tableText(header: string[], rows: string[][], align: ("left" | "right" | "center")[]): string {
  const all = [header, ...rows].map((r) => r.map(plainCell));
  const widths = header.map((_, k) => Math.min(24, Math.max(...all.map((r) => (r[k] ?? "").length))));
  const fmt = (r: string[]) =>
    r
      .map((c, k) => {
        const cell = (c ?? "").slice(0, widths[k]);
        return align[k] === "right" ? cell.padStart(widths[k]) : cell.padEnd(widths[k]);
      })
      .join("  ")
      .trimEnd();
  const lines = [fmt(all[0]), widths.map((w) => "-".repeat(w)).join("  "), ...all.slice(1).map(fmt)];
  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

/**
 * Turns a saved AI reply into Telegram HTML plus its "Xem tiếp" suggestions (the `>> …` lines the app shows as
 * buttons). Long replies are cut with a pointer to the app rather than split into many messages.
 */
export function formatForTelegram(content: string): { html: string; suggestions: string[] } {
  const { body, suggestions } = splitSuggestions(content);
  const parts = parseBlocks(body).map((b) => {
    switch (b.type) {
      case "heading":
        return `<b>${escapeHtml(b.text)}</b>`;
      case "list":
        return b.items.map((it) => `• ${inlineHtml(parseInline(it))}`).join("\n");
      case "table":
        return tableText(b.header, b.rows, b.align);
      default:
        return inlineHtml(parseInline(b.text));
    }
  });
  let html = parts.join("\n\n").trim() || "…";
  if (html.length > SAFE_LIMIT) {
    // Cut on a block boundary so no HTML tag is left open.
    let kept = "";
    for (const part of parts) {
      if ((kept + "\n\n" + part).length > SAFE_LIMIT) break;
      kept = kept ? `${kept}\n\n${part}` : part;
    }
    html = `${kept || escapeHtml(body.slice(0, SAFE_LIMIT))}\n\n… (xem đầy đủ trong app)`;
  }
  return { html: html.slice(0, TELEGRAM_MAX_CHARS), suggestions };
}

type InlineButton = { text: string; callback_data: string } | { text: string; url: string };

const buttonLabel = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

/**
 * Buttons under a reply: answer choices first (one per row), then "Xem tiếp" questions, then links that open the
 * page in the app. callback_data only carries the job number and an index (Telegram allows 64 bytes); the text is
 * looked up again from the saved reply when tapped, so nothing a client sends is trusted as the answer.
 */
export function keyboardFor(reply: Pick<ChatMessageDoc, "jobSeq" | "choices" | "links" | "kind">, suggestions: string[]): InlineButton[][] {
  const rows: InlineButton[][] = [];
  const choices = reply.kind === "question" ? reply.choices ?? [] : [];
  choices.forEach((c, i) => rows.push([{ text: buttonLabel(c), callback_data: `c:${reply.jobSeq}:${i}` }]));
  if (choices.length === 0) suggestions.forEach((s, i) => rows.push([{ text: `» ${buttonLabel(s)}`, callback_data: `s:${reply.jobSeq}:${i}` }]));
  const links = (reply.links ?? [])
    .map((l: ChatLink) => ({ text: buttonLabel(l.label), url: appUrl(l.href) }))
    .filter((b): b is { text: string; url: string } => b.url !== null);
  for (let i = 0; i < links.length; i += 2) rows.push(links.slice(i, i + 2));
  return rows;
}

/** Sends a saved reply to the Telegram chat the job came from. Used as the runner's onJobDone hook. */
export async function deliverReplyToTelegram(job: JobDoc): Promise<void> {
  if (job.origin?.channel !== "telegram") return;
  const cfg = telegramConfig();
  if (!cfg) return;
  const reply = await getReplyMessage(job);
  if (!reply) return;
  const { html, suggestions } = formatForTelegram(reply.content);
  const keyboard = keyboardFor(reply, suggestions);
  await tg(cfg, "sendMessage", {
    chat_id: job.origin.chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

/* --------------------------------- updates --------------------------------- */

interface TgUser {
  id: number;
}
interface TgChat {
  id: number;
  type: string;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
}
interface TgCallback {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

/** The app member a Telegram account is tied to — only if it's on the allow-list AND still a member of this store. */
async function memberForTelegramUser(cfg: TelegramConfig, telegramUserId: number): Promise<AuthedUser | null> {
  const email = cfg.allowed.get(telegramUserId);
  if (!email) return null;
  return memberByEmail(getAdminDb(), email, currentStoreId());
}

const WELCOME =
  "Xin chào! Đây là trợ lý hoá đơn của cửa hàng. Cứ nhắn đơn hàng như bình thường (vd: \"giao chị Hoa 5 thùng milo\"), hoặc hỏi \"chị Hoa có mấy đơn giao chưa tính tiền?\".";

/**
 * Handles one webhook update. Returns the id of a chat job to run (the caller runs it after answering Telegram),
 * or null when there is nothing to run. Never throws for a bad/unknown update — Telegram would just resend it.
 */
export async function handleTelegramUpdate(cfg: TelegramConfig, update: TgUpdate): Promise<string | null> {
  const msg = update.message;
  const cb = update.callback_query;
  const from = msg?.from ?? cb?.from;
  const chat = msg?.chat ?? cb?.message?.chat;
  if (!from || !chat) return null;
  // Private chats only: in a group, other people could see the business data or talk to the bot.
  if (chat.type !== "private") return null;

  const member = await memberForTelegramUser(cfg, from.id);
  if (!member) {
    if (cb) await tg(cfg, "answerCallbackQuery", { callback_query_id: cb.id });
    await tg(cfg, "sendMessage", {
      chat_id: chat.id,
      text: `Tài khoản Telegram này chưa được cấp quyền dùng trợ lý. Gửi số ID này cho chủ cửa hàng để được thêm vào: ${from.id}`,
    });
    logJob("telegram_denied", "none", { reason: "not_allowed" });
    return null;
  }
  const origin: JobOrigin = { channel: "telegram", chatId: chat.id, telegramUserId: from.id };

  let content: string | null = null;
  let requestId: string;
  if (cb) {
    requestId = `tgcb_${cb.id}`.slice(0, 64);
    const m = /^([cs]):(\d{1,8}):(\d{1,2})$/.exec(cb.data ?? "");
    if (m) {
      const reply = await getReplyMessageBySeq(telegramConversationIdFor(member.storeId, member.uid, from.id), Number(m[2]));
      const list = m[1] === "c" ? reply?.choices ?? [] : reply ? splitSuggestions(reply.content).suggestions : [];
      content = list[Number(m[3])] ?? null;
    }
    await tg(cfg, "answerCallbackQuery", { callback_query_id: cb.id, ...(content ? { text: `Đã chọn: ${buttonLabel(content)}` } : {}) });
    if (!content) return null;
    // Remove the buttons so the same answer can't be tapped twice.
    if (cb.message) await tg(cfg, "editMessageReplyMarkup", { chat_id: chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
    await tg(cfg, "sendMessage", { chat_id: chat.id, text: `› ${content}` });
  } else {
    requestId = `tg_${String(update.update_id).padStart(8, "0")}`;
    const text = msg?.text?.trim();
    if (!text) {
      await tg(cfg, "sendMessage", { chat_id: chat.id, text: "Hiện mình chỉ đọc được tin nhắn chữ." });
      return null;
    }
    if (/^\/(start|help|id)\b/.test(text)) {
      await tg(cfg, "sendMessage", { chat_id: chat.id, text: `${WELCOME}\n\nTelegram ID của bạn: ${from.id}` });
      return null;
    }
    content = text;
  }

  // The marker tells the AI to keep it short and expect shorthand (system prompt rule 15).
  let accepted;
  try {
    accepted = await acceptMessage(member, { requestId, content: `[Telegram] ${content}` }, origin);
  } catch (err) {
    // e.g. too many messages waiting, or a message that is too long: tell her instead of going silent.
    if (err instanceof HttpError) {
      await tg(cfg, "sendMessage", { chat_id: chat.id, text: err.message });
      return null;
    }
    throw err;
  }
  // A resent update returns the job we already took; running it again is a no-op unless the first run died.
  if (accepted.duplicate) return accepted.jobId;
  await tg(cfg, "sendChatAction", { chat_id: chat.id, action: "typing" });
  return accepted.jobId;
}
