import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests, getAdminDb } from "./firebaseAdmin";
import { isMember } from "./membership";
import { authenticate, currentStoreId, HttpError } from "./auth";

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  vi.unstubAllEnvs();
});

describe("isMember — the single membership source", () => {
  it("is false when no membership doc exists at all", async () => {
    expect(await isMember(getAdminDb(), "u1", "main")).toBe(false);
  });

  it("is true only when the doc exists AND its storeId matches", async () => {
    store.put("storeMembers/u1", { uid: "u1", email: "a@x.com", storeId: "main", addedAt: 1, addedByEmail: "admin@x.com" });
    expect(await isMember(getAdminDb(), "u1", "main")).toBe(true);
    expect(await isMember(getAdminDb(), "u1", "other-store")).toBe(false); // mismatched store context is rejected, not silently granted
  });

  it("is false for an empty or missing uid/storeId (defends against accidental wildcard checks)", async () => {
    store.put("storeMembers/u1", { uid: "u1", email: "a@x.com", storeId: "main", addedAt: 1, addedByEmail: "admin@x.com" });
    expect(await isMember(getAdminDb(), "", "main")).toBe(false);
    expect(await isMember(getAdminDb(), "u1", "")).toBe(false);
  });

  it("membership for one uid never grants another uid", async () => {
    store.put("storeMembers/u1", { uid: "u1", email: "a@x.com", storeId: "main", addedAt: 1, addedByEmail: "admin@x.com" });
    expect(await isMember(getAdminDb(), "u2", "main")).toBe(false);
  });
});

/** authenticate() needs a verified ID token; fake it by swapping the Admin Auth accessor used inside via env-free unit testing is
 * impractical here (verifyIdToken talks to Google's certs), so these tests cover the parts under our control: the
 * membership gate itself (via isMember, above) and the header-parsing / error-shape contract, which is what
 * every route in this app actually depends on. Full token verification is exercised implicitly by every emulator
 * test (which signs in real-shaped auth contexts) and is standard, unmodified Firebase Admin SDK behavior.
 */
describe("authenticate() — header contract", () => {
  it("rejects a request with no Authorization header before ever touching membership", async () => {
    const req = new Request("http://localhost/api/x", { method: "POST" });
    await expect(authenticate(req)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a malformed Authorization header the same way (no info leak about why)", async () => {
    const req = new Request("http://localhost/api/x", { method: "POST", headers: { authorization: "Basic garbage" } });
    await expect(authenticate(req)).rejects.toBeInstanceOf(HttpError);
    await expect(authenticate(req)).rejects.toMatchObject({ status: 401 });
  });

  it("currentStoreId defaults to 'main' and reads APP_STORE_ID when set", () => {
    expect(currentStoreId()).toBe("main");
    vi.stubEnv("APP_STORE_ID", "  other  ");
    expect(currentStoreId()).toBe("other");
  });
});
