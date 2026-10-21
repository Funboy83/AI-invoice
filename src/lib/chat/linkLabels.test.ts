import { describe, expect, it } from "vitest";
import { translateChatLink } from "./linkLabels";

describe("translateChatLink", () => {
  it("keeps the saved Vietnamese label in Vietnamese", () => {
    expect(translateChatLink("Mở invoice #2001", "vi")).toBe("Mở invoice #2001");
  });
  it("rewrites known labels in English, keeping names and numbers", () => {
    expect(translateChatLink("Mở invoice #2001", "en")).toBe("Open invoice #2001");
    expect(translateChatLink("Khách: Chị Hoa", "en")).toBe("Customer: Chị Hoa");
    expect(translateChatLink("Invoice chưa thanh toán", "en")).toBe("Unpaid invoices");
  });
  it("leaves unknown labels alone", () => {
    expect(translateChatLink("Something else", "en")).toBe("Something else");
  });
});
