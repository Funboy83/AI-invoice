/**
 * Tiny parser for the bits of Markdown the AI is asked to use in chat replies: tables (lists of invoices, customers,
 * products…), **bold**, and links to in-app pages. Everything else stays plain text exactly as written.
 * Pure (no React) so it can be unit-tested.
 */
import { isSafeChatHref } from "./links";

export type Inline = { type: "text"; text: string } | { type: "bold"; text: string } | { type: "link"; text: string; href: string };

export type Block =
  | { type: "text"; text: string }
  | { type: "heading"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; header: string[]; rows: string[][]; align: ("left" | "right" | "center")[] };

const isTableLine = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isSeparatorLine = (line: string) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(line);

/** Splits `| a | b |` into ["a", "b"]; `\|` inside a cell is kept as a literal pipe. */
export function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

export function parseBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let text: string[] = [];
  const flushText = () => {
    // Drop blank lines right next to a table so the spacing comes from the layout, not stray newlines.
    while (text.length && !text[0].trim()) text.shift();
    while (text.length && !text[text.length - 1].trim()) text.pop();
    if (text.length) blocks.push({ type: "text", text: text.join("\n") });
    text = [];
  };

  let i = 0;
  while (i < lines.length) {
    if (isTableLine(lines[i]) && i + 1 < lines.length && isSeparatorLine(lines[i + 1])) {
      const header = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"
      ) as ("left" | "right" | "center")[];
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableLine(lines[i])) {
        const cells = splitRow(lines[i]);
        // Pad/trim to the header width so a sloppy row can't break the layout.
        rows.push(header.map((_, k) => cells[k] ?? ""));
        i++;
      }
      flushText();
      blocks.push({ type: "table", header, rows, align: header.map((_, k) => align[k] ?? "left") });
      continue;
    }
    const heading = /^\s*#{1,4}\s+(.+)$/.exec(lines[i]);
    if (heading) {
      flushText();
      blocks.push({ type: "heading", text: heading[1].trim() });
      i++;
      continue;
    }
    if (BULLET_RE.test(lines[i])) {
      flushText();
      const items: string[] = [];
      while (i < lines.length && BULLET_RE.test(lines[i])) items.push(lines[i++].replace(BULLET_RE, "").trim());
      blocks.push({ type: "list", items });
      continue;
    }
    text.push(lines[i]);
    i++;
  }
  flushText();
  return blocks;
}

const BULLET_RE = /^\s*[-*•]\s+/;
const SUGGESTION_RE = /^\s*>>\s*(.+?)\s*$/;

/**
 * The AI ends a reply with up to 3 "next question" lines written as `>> Xem nợ của chị Hoa` (like KiotViet's
 * "Xem tiếp" buttons). This splits them off the end of the text so they can be shown as tap-to-ask buttons.
 */
export function splitSuggestions(content: string): { body: string; suggestions: string[] } {
  const lines = content.split("\n");
  const suggestions: string[] = [];
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    const m = SUGGESTION_RE.exec(line);
    if (m) suggestions.unshift(m[1].replace(/\*\*/g, ""));
    else if (line.trim() && !/^\s*(xem tiếp|gợi ý)[^:]*:\s*$/i.test(line)) break;
    end--;
  }
  // Only lines at the very end count; never strip the whole reply.
  if (suggestions.length === 0 || end === 0) return { body: content, suggestions: [] };
  return { body: lines.slice(0, end).join("\n").trimEnd(), suggestions: suggestions.slice(0, 3) };
}

/** **bold** and [label](/in-app/path). A link to anything other than an in-app page stays plain text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: "bold", text: m[1] });
    else if (isSafeChatHref(m[3])) out.push({ type: "link", text: m[2], href: m[3] });
    else out.push({ type: "text", text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

/** True for cells that read as a number or money amount ($1,250.00, -3, 12 thùng is NOT) — right-aligned in tables. */
export const isNumericCell = (cell: string) => /^[-+]?\$?\s?[\d,]+(\.\d+)?%?$/.test(cell.replace(/\*\*/g, "").trim());
