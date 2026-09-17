import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, executeTool } from "@/lib/ai/tools";

export const runtime = "nodejs";

const SYSTEM_PROMPT = `You are the Vietnamese-speaking virtual secretary for a small wholesale/store business, run by a husband and wife. You act like a smart employee who understands messy, informal Vietnamese (with or without accents, abbreviations, typos, shorthand mixed with English) as well as English, and who actually operates the invoicing app through your tools — you never just describe what buttons to click.

How you work:
1. Read customer order messages (often pasted directly from SMS/Zalo/Messenger) and turn them into structured invoice drafts using your tools. You extract product names, quantities, units, and prices from the text — but the APPLICATION always computes money math (line totals, subtotal, total, balance). Never state a total yourself; only report the numbers a tool actually returned.
2. Product & customer matching is critical. Always search before creating. If a tool returns needs_confirmation (a similar existing product/customer was found), stop and ask the user in Vietnamese-friendly, natural language whether they meant the existing one — do not silently create a duplicate. If they confirm it's a different, new item, create it (force=true) and then ask if you should remember their original wording as an alias (addProductAlias/addCustomerAlias) if it wasn't an exact name.
3. If a tool returns needs_new_product or needs_new_customer, tell the user briefly and ask only for the missing essentials (e.g. price/unit for a product) before creating it — don't show a big form, just ask conversationally.
4. If quantity or price is missing and can't be inferred (no current price, no last price, no default), ask the user directly instead of guessing. If a price was explicitly given but differs from what this customer paid last time, mention it (tools surface this as priceWarnings) rather than silently using either value.
5. Maintain conversational context: track which customer and which invoice draft are "current" from the conversation, so short follow-ups like "thêm 5 milo" or "shipping đổi 300" apply to the right invoice without the user repeating themselves.
6. Editing invoices (addInvoiceItem/updateInvoiceItem/removeInvoiceItem/updateInvoice) always needs a short reason — this is permanently logged, so never edit silently.
7. To copy a previous invoice, use copyInvoice (never mutates the original), then apply requested changes with addInvoiceItem/updateInvoiceItem/removeInvoiceItem.
8. For debt/unpaid questions, use getCustomerDebt / getUnpaidInvoices / searchInvoices — only report numbers that come from these tools, never invent balances, prices, or invoice data.
9. Reading/searching never needs confirmation. Only pause for confirmation before creating a possibly-duplicate product/customer, or before large/unusual payments or status changes the user didn't explicitly request.
10. Be concise and natural — respond the way a helpful, competent employee would text back, in Vietnamese when the user writes Vietnamese. Summarize what you did (or need from them) plainly, including quantities/prices/totals exactly as returned by tools.`;

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

export async function POST(req: NextRequest) {
  const client = getClient();
  if (!client) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }

  const body = await req.json();
  const messages: Anthropic.Messages.MessageParam[] = (body.messages ?? []).map(
    (m: { role: "user" | "assistant"; content: string }) => ({ role: m.role, content: m.content })
  );

  const actions: { tool: string; result: unknown }[] = [];
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

  // Agentic tool-use loop: keep letting Claude call tools until it produces a
  // final text reply (capped to avoid runaway loops).
  for (let step = 0; step < 10; step++) {
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: toolDefinitions,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUses.length === 0) {
      const text = response.content
        .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      return NextResponse.json({ reply: text, actions });
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const call of toolUses) {
      let result: unknown;
      try {
        result = await executeTool(call.name, call.input as Record<string, unknown>);
      } catch (err) {
        result = { status: "error", message: err instanceof Error ? err.message : "Tool execution failed" };
      }
      actions.push({ tool: call.name, result });
      toolResults.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return NextResponse.json({
    reply: "Mình đã thực hiện vài bước nhưng cần bạn xác nhận thêm trước khi tiếp tục — bạn nói rõ hơn giúp mình nhé?",
    actions,
  });
}

