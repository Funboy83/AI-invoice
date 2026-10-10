import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import { store } from "@/test/fakeFirestore";
import { resetRunnerEnv, seedCatalog, scriptedModel, deps, text, toolUse, wife } from "@/test/runnerKit";
import { driveJob } from "./agentRunner";
import { telegramConversationIdFor, type JobDoc } from "./chatJobs";
import {
  deliverReplyToTelegram,
  formatForTelegram,
  handleTelegramUpdate,
  keyboardFor,
  parseAllowedUsers,
  secretMatches,
  telegramConfig,
  telegramTransport,
  type TelegramConfig,
  type TgUpdate,
} from "./telegram";

const TG_USER = 555001;
const ENV = {
  TELEGRAM_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_WEBHOOK_SECRET: "s3cret-value",
  TELEGRAM_ALLOWED_USERS: `${TG_USER}:wife@example.com`,
  APP_BASE_URL: "https://shop.example.com",
};
const CID = telegramConversationIdFor("main", wife.uid, TG_USER);

let sent: { method: string; body: Record<string, unknown> }[] = [];
let cfg: TelegramConfig;
let updateId = 1000;

beforeEach(() => {
  resetRunnerEnv();
  seedCatalog();
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  cfg = telegramConfig()!;
  sent = [];
  telegramTransport.call = async (_token, method, body) => {
    sent.push({ method, body });
    return { ok: true };
  };
});
afterEach(() => vi.unstubAllEnvs());

const textUpdate = (text: string, from = TG_USER, chatType = "private"): TgUpdate => ({
  update_id: ++updateId,
  message: { message_id: updateId, from: { id: from }, chat: { id: from, type: chatType }, text },
});
const messages = (method: string) => sent.filter((s) => s.method === method).map((s) => s.body);
const runWithTelegram = (jobId: string, model: ReturnType<typeof scriptedModel>) =>
  driveJob(jobId, deps(model, { onJobDone: deliverReplyToTelegram }));

describe("configuration", () => {
  it("is off unless enabled AND the token and webhook secret are set", () => {
    expect(telegramConfig({})).toBeNull();
    expect(telegramConfig({ TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "x" })).toBeNull();
    expect(telegramConfig({ TELEGRAM_BOT_TOKEN: "x", TELEGRAM_WEBHOOK_SECRET: "y" })).toBeNull();
    expect(telegramConfig({ TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "x", TELEGRAM_WEBHOOK_SECRET: "y" })).not.toBeNull();
  });

  it("parses the allow-list and ignores malformed entries", () => {
    const m = parseAllowedUsers("123:A@B.com, junk, 456 : c@d.vn;abc:e@f.com");
    expect([...m.entries()]).toEqual([
      [123, "a@b.com"],
      [456, "c@d.vn"],
    ]);
  });

  it("checks the webhook secret exactly", () => {
    expect(secretMatches("s3cret-value", "s3cret-value")).toBe(true);
    expect(secretMatches("s3cret-valu", "s3cret-value")).toBe(false);
    expect(secretMatches(null, "s3cret-value")).toBe(false);
  });
});

describe("who can talk to the bot", () => {
  it("an unknown Telegram account gets its ID (to give the owner) and nothing is processed", async () => {
    expect(await handleTelegramUpdate(cfg, textUpdate("giao 5 milo", 999))).toBeNull();
    expect(String(messages("sendMessage")[0].text)).toContain("999");
    expect(store.count("chatJobs")).toBe(0);
  });

  it("an allow-listed account whose app access was removed is refused too", async () => {
    store.docs.delete(`storeMembers/${wife.uid}`);
    expect(await handleTelegramUpdate(cfg, textUpdate("giao 5 milo"))).toBeNull();
    expect(store.count("chatJobs")).toBe(0);
  });

  it("group chats are ignored", async () => {
    expect(await handleTelegramUpdate(cfg, textUpdate("giao 5 milo", TG_USER, "group"))).toBeNull();
    expect(sent).toEqual([]);
  });

  it("an allowed member's message becomes a job in its own Telegram conversation (not the in-app chat)", async () => {
    const jobId = await handleTelegramUpdate(cfg, textUpdate("giao chi hoa 5 thung milo"));
    expect(jobId).toBe(`${CID}__j000001`);
    const job = store.read(`chatJobs/${jobId}`) as unknown as JobDoc;
    expect(job.ownerUid).toBe(wife.uid);
    expect(job.origin).toEqual({ channel: "telegram", chatId: TG_USER, telegramUserId: TG_USER });
    expect(store.read(`chatConversations/${CID}/messages/00000002`)?.content).toBe("[Telegram] giao chi hoa 5 thung milo");
    expect(store.read("chatConversations/main__wife")).toBeUndefined();
  });

  it("Telegram resending the same update does not create a second job", async () => {
    const u = textUpdate("giao 5 milo");
    const a = await handleTelegramUpdate(cfg, u);
    const b = await handleTelegramUpdate(cfg, u);
    expect(b).toBe(a);
    expect(store.count("chatJobs")).toBe(1);
  });
});

describe("a messy delivery order from Telegram, end to end", () => {
  it("previews, asks with buttons, and saves only after she taps yes", async () => {
    const order = { customerName: "hoa lee", originalOrderText: "giao chi hoa 5 thung milo", items: [{ productName: "milo", quantity: 5 }] };

    // 1) The AI reads the order, gets a preview back (nothing saved) and asks.
    const first = await handleTelegramUpdate(cfg, textUpdate("giao chi hoa 5 thung milo"));
    await runWithTelegram(
      first!,
      scriptedModel([
        [toolUse("t1", "createDeliveryOrder", order)],
        [toolUse("t2", "requestUserInput", { question: "Đơn giao cho **Hoa Lee**: Milo × 5 thùng (chưa có giá). Lưu nhé?", options: ["Đúng, lưu đơn giao", "Sửa lại"] })],
      ])
    );
    expect(store.count("invoices")).toBe(0);
    expect(JSON.parse(String((store.read(`chatJobs/${first}/toolCalls/t1`) as { resultJson: string }).resultJson)).status).toBe("needs_confirmation");
    const question = messages("sendMessage").at(-1)!;
    expect(question.parse_mode).toBe("HTML");
    expect(question.text).toContain("<b>Hoa Lee</b>");
    const keyboard = (question.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }).inline_keyboard;
    expect(keyboard.map((r) => r[0].text)).toEqual(["Đúng, lưu đơn giao", "Sửa lại"]);
    expect(keyboard[0][0].callback_data).toBe("c:1:0");

    // 2) She taps "Đúng, lưu đơn giao": the answer is looked up from the saved question, not taken from Telegram.
    sent = [];
    const tap: TgUpdate = {
      update_id: ++updateId,
      callback_query: { id: "cbq-000000001", from: { id: TG_USER }, message: { message_id: 77, chat: { id: TG_USER, type: "private" } }, data: "c:1:0" },
    };
    const second = await handleTelegramUpdate(cfg, tap);
    expect(messages("editMessageReplyMarkup")).toHaveLength(1); // buttons removed so it can't be tapped twice
    expect(store.read(`chatConversations/${CID}/messages/00000004`)?.content).toBe("[Telegram] Đúng, lưu đơn giao");
    expect((store.read(`chatJobs/${second}`) as unknown as JobDoc).canConfirm).toBe(true);

    await runWithTelegram(
      second!,
      scriptedModel([
        [toolUse("t3", "createDeliveryOrder", { ...order, confirmed: true })],
        [text("Đã lưu đơn giao **#2000** cho Hoa Lee.\n\n>> Chị Hoa có mấy đơn giao chưa tính tiền?")],
      ])
    );
    const invoices = store.list("invoices");
    expect(invoices).toHaveLength(1);
    expect(invoices[0][1]).toMatchObject({ customerName: "Hoa Lee", paymentStatus: "unpaid", delivery: { status: "open" }, total: 0 });

    const done = messages("sendMessage").at(-1)!;
    expect(done.text).toContain("<b>#2000</b>");
    expect(done.text).not.toContain(">>");
    const rows = (done.reply_markup as { inline_keyboard: Record<string, string>[][] }).inline_keyboard;
    expect(rows[0][0]).toMatchObject({ text: "» Chị Hoa có mấy đơn giao chưa tính tiền?", callback_data: "s:2:0" });
    expect(rows.flat().some((b) => b.url === `https://shop.example.com/invoices/${invoices[0][0]}`)).toBe(true);
  });

  it("a stale or forged button does nothing", async () => {
    const tap: TgUpdate = { update_id: ++updateId, callback_query: { id: "cbq-000000002", from: { id: TG_USER }, data: "c:9:0", message: { message_id: 1, chat: { id: TG_USER, type: "private" } } } };
    expect(await handleTelegramUpdate(cfg, tap)).toBeNull();
    expect(store.count("chatJobs")).toBe(0);
  });

  it("app chats are never sent to Telegram", async () => {
    await deliverReplyToTelegram({ origin: undefined } as unknown as JobDoc);
    expect(sent).toEqual([]);
  });
});

describe("formatting", () => {
  it("turns tables into a monospace block, escapes HTML, and splits off suggestions", () => {
    const { html, suggestions } = formatForTelegram(
      "## Nợ <khách>\n| Invoice | Còn nợ |\n|---|---:|\n| [#2001](/invoices/abc) | $1,250.00 |\n| #2002 | $5.00 |\n\n>> Xem nợ chị Hoa"
    );
    expect(html).toContain("<b>Nợ &lt;khách&gt;</b>");
    expect(html).toContain("<pre>Invoice     Còn nợ\n");
    expect(html).toContain("#2001    $1,250.00");
    expect(suggestions).toEqual(["Xem nợ chị Hoa"]);
  });

  it("cuts very long replies with a pointer to the app", () => {
    const { html } = formatForTelegram(Array.from({ length: 400 }, (_, i) => `dòng ${i} ${"x".repeat(20)}`).join("\n\n"));
    expect(html.length).toBeLessThanOrEqual(4096);
    expect(html).toContain("xem đầy đủ trong app");
  });

  it("only questions get answer buttons; links need a public https address", () => {
    const rows = keyboardFor({ jobSeq: 3, kind: "text", choices: ["a"], links: [{ href: "/invoices/x", label: "Mở invoice #1" }] }, []);
    expect(rows).toEqual([[{ text: "Mở invoice #1", url: "https://shop.example.com/invoices/x" }]]);
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    expect(keyboardFor({ jobSeq: 3, kind: "text", links: [{ href: "/invoices/x", label: "x" }] }, [])).toEqual([]);
  });
});

describe("webhook route", () => {
  const call = async (headers: Record<string, string>, body: unknown = textUpdate("hi")) => {
    const { POST } = await import("@/app/api/telegram/webhook/route");
    const { NextRequest } = await import("next/server");
    return POST(new NextRequest("http://localhost/api/telegram/webhook", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  };

  it("is 404 while Telegram is not turned on", async () => {
    vi.stubEnv("TELEGRAM_ENABLED", "");
    expect((await call({ "x-telegram-bot-api-secret-token": ENV.TELEGRAM_WEBHOOK_SECRET })).status).toBe(404);
  });

  it("rejects a request without the secret Telegram was given, before reading it", async () => {
    expect((await call({})).status).toBe(403);
    expect((await call({ "x-telegram-bot-api-secret-token": "wrong" })).status).toBe(403);
    expect(sent).toEqual([]);
  });
});
