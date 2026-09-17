"use client";

import { useState } from "react";

export interface ChatUiMessage {
  role: "user" | "assistant";
  content: string;
  actions?: { tool: string; result: unknown }[];
}

const WELCOME =
  "Chào bạn! Mình là trợ lý AI của cửa hàng — bạn có thể dán tin nhắn đặt hàng của khách, hỏi công nợ, tìm invoice, hoặc nhờ mình sửa invoice. Có gì mình sẽ hỏi lại nếu chưa rõ nhé.";

/** Shared chat state/logic used by both the desktop drawer and the mobile full-screen home. */
export function useAiChat() {
  const [messages, setMessages] = useState<ChatUiMessage[]>([{ role: "assistant", content: WELCOME }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;
    const nextMessages: ChatUiMessage[] = [...messages, { role: "user", content }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ ${data.error ?? "Có lỗi xảy ra."}` }]);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: data.reply, actions: data.actions }]);
      }
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "⚠️ Lỗi kết nối — thử lại nhé." }]);
    } finally {
      setLoading(false);
    }
  }

  return { messages, input, setInput, loading, send };
}

export function actionSummary(tool: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  const status = typeof r.status === "string" ? r.status : undefined;
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
