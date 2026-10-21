import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { translate } from "./translate";
import { vi } from "./vi";

describe("translate", () => {
  it("shows Vietnamese by key and English as written", () => {
    expect(translate("vi", "Customers")).toBe("Khách hàng");
    expect(translate("en", "Customers")).toBe("Customers");
  });
  it("fills {marks} in both languages", () => {
    expect(translate("vi", "Invoice #{n}", { n: 2001 })).toBe("Hóa đơn #2001");
    expect(translate("en", "Invoice #{n}", { n: 2001 })).toBe("Invoice #2001");
  });
  it("falls back to the text itself when there is no entry (e.g. a server message)", () => {
    expect(translate("vi", "Some server message")).toBe("Some server message");
  });
});

/** Every literal t("...") on a screen must have a Vietnamese entry, so a new button can't slip through in English. */
describe("Vietnamese dictionary", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f) && !/\.test\./.test(f)) files.push(p);
    }
  };
  walk(path.resolve(__dirname, "../.."));

  const keys = new Set<string>();
  const literal = /\bt\(\s*"((?:[^"\\]|\\.)*)"/g;
  const ternary = /\bt\(\s*[^"()]*\?\s*"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(literal)) keys.add(JSON.parse(`"${m[1]}"`));
    for (const m of src.matchAll(ternary)) [m[1], m[2]].forEach((k) => keys.add(JSON.parse(`"${k}"`)));
  }

  it("finds the screen text", () => {
    expect(keys.size).toBeGreaterThan(300);
  });
  it("has a Vietnamese entry for every key", () => {
    expect([...keys].filter((k) => !(k in vi))).toEqual([]);
  });
  it("keeps every {mark} of the English text in the Vietnamese text", () => {
    const marks = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
    expect(Object.entries(vi).filter(([en, v]) => marks(en) !== marks(v))).toEqual([]);
  });
});
