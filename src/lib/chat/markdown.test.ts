import { describe, expect, it } from "vitest";
import { isNumericCell, parseBlocks, parseInline, splitSuggestions } from "./markdown";

describe("parseBlocks", () => {
  it("turns a Markdown table into a table block between text blocks", () => {
    const content = [
      "Có 2 invoice chưa thanh toán:",
      "",
      "| Invoice | Khách | Còn nợ |",
      "|---|---|---:|",
      "| #2001 | Chị Hoa | $120.00 |",
      "| #2002 | Anh Tâm | $45.50 |",
      "",
      "Tổng nợ: **$165.50**",
    ].join("\n");
    expect(parseBlocks(content)).toEqual([
      { type: "text", text: "Có 2 invoice chưa thanh toán:" },
      {
        type: "table",
        header: ["Invoice", "Khách", "Còn nợ"],
        align: ["left", "left", "right"],
        rows: [
          ["#2001", "Chị Hoa", "$120.00"],
          ["#2002", "Anh Tâm", "$45.50"],
        ],
      },
      { type: "text", text: "Tổng nợ: **$165.50**" },
    ]);
  });

  it("pads short rows and drops extra cells", () => {
    const [table] = parseBlocks("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |");
    expect(table).toMatchObject({ rows: [["1", ""], ["1", "2"]] });
  });

  it("leaves text with pipes but no separator row alone", () => {
    expect(parseBlocks("| not a table |\nhello")).toEqual([{ type: "text", text: "| not a table |\nhello" }]);
  });

  it("keeps plain text unchanged", () => {
    expect(parseBlocks("Dạ em đã tạo invoice.\nChị xem giúp em nhé")).toEqual([{ type: "text", text: "Dạ em đã tạo invoice.\nChị xem giúp em nhé" }]);
  });
});

describe("parseInline", () => {
  it("parses bold and in-app links, and leaves outside links as plain text", () => {
    expect(parseInline("Xem **#2001** tại [đây](/invoices/abc) hoặc [web](https://x.com)")).toEqual([
      { type: "text", text: "Xem " },
      { type: "bold", text: "#2001" },
      { type: "text", text: " tại " },
      { type: "link", text: "đây", href: "/invoices/abc" },
      { type: "text", text: " hoặc " },
      { type: "text", text: "web" },
    ]);
  });
});

describe("isNumericCell", () => {
  it("recognises money and numbers only", () => {
    expect(isNumericCell("$1,250.00")).toBe(true);
    expect(isNumericCell("**$12**")).toBe(true);
    expect(isNumericCell("12")).toBe(true);
    expect(isNumericCell("12 thùng")).toBe(false);
    expect(isNumericCell("Chị Hoa")).toBe(false);
  });
});

describe("headings and bullet lists", () => {
  it("splits headings and bullets into their own blocks", () => {
    expect(parseBlocks("Dạ:\n## Gợi ý hành động\n- Kiểm tra **tồn**\n- Xem top\nXong")).toEqual([
      { type: "text", text: "Dạ:" },
      { type: "heading", text: "Gợi ý hành động" },
      { type: "list", items: ["Kiểm tra **tồn**", "Xem top"] },
      { type: "text", text: "Xong" },
    ]);
  });
});

describe("splitSuggestions", () => {
  it("takes trailing >> lines off as suggestions", () => {
    expect(splitSuggestions("Chị Hoa nợ $120.\n\nXem tiếp:\n>> Xem invoice chưa trả của chị Hoa\n>> **Ghi nhận** thanh toán")).toEqual({
      body: "Chị Hoa nợ $120.",
      suggestions: ["Xem invoice chưa trả của chị Hoa", "Ghi nhận thanh toán"],
    });
  });
  it("ignores >> lines that are not at the end, and never empties the reply", () => {
    expect(splitSuggestions(">> a\nhello")).toEqual({ body: ">> a\nhello", suggestions: [] });
    expect(splitSuggestions(">> only")).toEqual({ body: ">> only", suggestions: [] });
  });
  it("keeps at most 3", () => {
    expect(splitSuggestions("x\n>> 1\n>> 2\n>> 3\n>> 4").suggestions).toEqual(["1", "2", "3"]);
  });
});
