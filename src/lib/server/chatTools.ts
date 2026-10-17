import { executeTool, MUTATING_TOOLS, toolDefinitions, type ToolContext } from "@/lib/ai/tools";
import { adminToolDefinitions, adminToolNames, runAdminTool } from "./adminTools";

/**
 * The in-app chat's (and Telegram's) full tool set: the chat tools (src/lib/ai/tools.ts) plus the admin tools the
 * outside-AI door also has (adminTools.ts: vendors, purchases, vendor payments, cancelling a purchase, the invoice
 * list and dashboard numbers, invoice history, payment request statement, Custom Invoice info). So the app's own AI
 * can do everything the app's pages can, like the MCP connector.
 *
 * Admin writes follow the chat's usual confirm pattern (like createCustomer): the first call only previews and returns
 * needs_confirmation with the preview and tap-to-answer choices; the save happens only when the call is in her reply
 * to that question (canConfirm) AND carries confirmed=true. The save goes through the same store functions as the app.
 */

const ADMIN_WRITES = adminToolDefinitions.filter((t) => !t.readOnly).map((t) => t.name);

const CHAT_CONFIRM_NOTE =
  " Nothing is saved on the first call: it returns needs_confirmation with a preview — show it, ask with requestUserInput (use the confirmChoices as options), and call again with the same details and confirmed=true only after she answers OK.";

export const chatToolDefinitions = [
  ...toolDefinitions,
  ...adminToolDefinitions.map((t) =>
    t.readOnly
      ? { name: t.name, description: t.description, input_schema: { ...t.input_schema, type: "object" as const } }
      : {
          name: t.name,
          description: t.description + CHAT_CONFIRM_NOTE,
          input_schema: {
            ...t.input_schema,
            type: "object" as const,
            properties: {
              ...(t.input_schema.properties as Record<string, unknown>),
              confirmed: { type: "boolean", description: "Set true only after the user confirmed the preview in reply to your question." },
            },
          },
        }
  ),
];

/** Every chat tool that changes data (each call gets a stable operation id, see agentRunner). */
export const CHAT_MUTATING_TOOLS: ReadonlySet<string> = new Set([...MUTATING_TOOLS, ...ADMIN_WRITES]);

export async function executeChatTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  if (!adminToolNames.has(name)) return executeTool(name, args, ctx);
  const { confirmed, ...rest } = args;
  if (!ADMIN_WRITES.includes(name)) return runAdminTool(name, rest);
  if (ctx.canConfirm && confirmed === true) return runAdminTool(name, rest, { operationId: ctx.operationId });
  const result = (await runAdminTool(name, rest, { previewOnly: true })) as Record<string, unknown>;
  if (result.status !== "preview") return result; // a question to ask, unchanged, or an error
  return {
    status: "needs_confirmation",
    message:
      "Nothing saved yet. Show the user this preview (the important lines, money before/after and any warnings) and ask with requestUserInput whether to save it, using confirmChoices as the options. If she says OK, call this tool again with the same details and confirmed=true. If she wants changes, apply them and preview again. If she cancels, save nothing.",
    preview: result.preview,
    confirmChoices: ["OK, lưu", "Sửa lại", "Hủy"],
  };
}
