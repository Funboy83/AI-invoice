import { describe, expect, it } from "vitest";
import { printFileName } from "./printFileName";

describe("printFileName", () => {
  it("joins the name without spaces and the date as DD-MM-YY", () => {
    expect(printFileName("Asia Pacific", "2026-10-20")).toBe("AsiaPacific20-10-26");
  });

  it("drops Vietnamese accents and symbols", () => {
    expect(printFileName("Tiệm Đức & Co.", "2026-01-05")).toBe("TiemDucCo05-01-26");
  });

  it("falls back when there is no name or date", () => {
    expect(printFileName("Hoa", "")).toBe("Hoa");
    expect(printFileName("", "")).toBe("invoice");
  });
});
