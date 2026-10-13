import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

/**
 * REAL Firestore rule evaluation against the emulator (not a simulation) — proves firestore.rules, as actually
 * deployed, behaves as claimed. Run with `npm run test:emulator` (needs Java + firebase-tools locally; see
 * README.md). Seeding uses withSecurityRulesDisabled, exactly as the Admin SDK bypasses rules in production —
 * matching "use emulator test accounts" from the task: MEMBER/OTHER_MEMBER/NON_MEMBER below are fake local
 * accounts that exist only inside this emulator run, never real ones.
 */

const PROJECT_ID = "demo-invoice-ai-taskb";
const MEMBER = { uid: "member-1", email: "member1@example.com" };
const OTHER_MEMBER = { uid: "member-2", email: "member2@example.com" };
const NON_MEMBER = { uid: "intruder-1", email: "intruder@example.com" };
const STORE_ID = "main"; // must match the STORE_ID() constant hardcoded in firestore.rules

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
}, 30_000);

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  // Seed exactly as the Admin SDK would (bypassing rules): two store members, one non-member account that simply
  // has never been added, and one invoice + its audit log + a payment, to test read/write against real documents.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "storeMembers", MEMBER.uid), { uid: MEMBER.uid, email: MEMBER.email, storeId: STORE_ID, addedAt: 1, addedByEmail: "admin@example.com" });
    await setDoc(doc(db, "storeMembers", OTHER_MEMBER.uid), { uid: OTHER_MEMBER.uid, email: OTHER_MEMBER.email, storeId: STORE_ID, addedAt: 1, addedByEmail: "admin@example.com" });
    await setDoc(doc(db, "products", "p1"), { name: "Milo", aliases: [], defaultUnit: "thùng", defaultPrice: 29, active: true, createdAt: 1, updatedAt: 1 });
    await setDoc(doc(db, "customers", "c1"), { name: "Hoa Lee", aliases: [], active: true, createdAt: 1, updatedAt: 1 });
    await setDoc(doc(db, "invoices", "inv1"), {
      invoiceNumber: "2000", date: 1, customerId: "c1", customerName: "Hoa Lee",
      items: [{ productId: "p1", productName: "Milo", quantity: 1, unit: "thùng", price: 29, lineTotal: 29 }],
      shipping: 0, discount: 0, subtotal: 29, total: 29, amountPaid: 0, balance: 29,
      paymentStatus: "unpaid", createdAt: 1, updatedAt: 1, createdBy: "ai",
    });
    await setDoc(doc(db, "invoiceLogs", "log1"), { invoiceId: "inv1", timestamp: 1, actor: "ai", action: "create", message: "Invoice 2000 created" });
    await setDoc(doc(db, "payments", "pay1"), { invoiceId: "inv1", customerId: "c1", amount: 10, method: "cash", createdAt: 1, actor: "ai" });
    await setDoc(doc(db, "counters", "invoiceCounter"), { value: 2000 });
    await setDoc(doc(db, "operations", "op1"), { operationId: "op1", tool: "createInvoice", createdAt: 1, resultJson: "{}" });
    await setDoc(doc(db, "chatConversations", `${STORE_ID}__${MEMBER.uid}`), { storeId: STORE_ID, ownerUid: MEMBER.uid, ownerEmail: MEMBER.email, jobCounter: 1, headSeq: 1, createdAt: 1, updatedAt: 1 });
    await setDoc(doc(db, "chatConversations", `${STORE_ID}__${MEMBER.uid}`, "messages", "00000002"), { ownerUid: MEMBER.uid, order: 2, role: "user", content: "hi", jobId: "j1", jobSeq: 1, createdAt: 1 });
  });
});

const asMember = () => env.authenticatedContext(MEMBER.uid, { email: MEMBER.email }).firestore();
const asOtherMember = () => env.authenticatedContext(OTHER_MEMBER.uid, { email: OTHER_MEMBER.email }).firestore();
const asNonMember = () => env.authenticatedContext(NON_MEMBER.uid, { email: NON_MEMBER.email }).firestore();
const asAnon = () => env.unauthenticatedContext().firestore();

const BUSINESS_COLLECTIONS = [
  { col: "products", id: "p1", write: { name: "hacked" } },
  { col: "customers", id: "c1", write: { name: "hacked" } },
  { col: "invoices", id: "inv1", write: { total: 999999 } },
  { col: "invoiceLogs", id: "log1", write: { message: "tampered" } },
  { col: "payments", id: "pay1", write: { amount: 999999 } },
];

describe("anonymous users: denied everywhere", () => {
  for (const { col, id } of BUSINESS_COLLECTIONS) {
    it(`cannot read ${col}`, async () => {
      await assertFails(getDoc(doc(asAnon(), col, id)));
      await assertFails(getDocs(collection(asAnon(), col)));
    });
  }
  it("cannot write a business document", async () => {
    await assertFails(setDoc(doc(asAnon(), "products", "new"), { name: "x", defaultPrice: 1 }));
  });
  it("cannot read any storeMembers doc, or grant itself membership", async () => {
    await assertFails(getDoc(doc(asAnon(), "storeMembers", MEMBER.uid)));
    await assertFails(setDoc(doc(asAnon(), "storeMembers", NON_MEMBER.uid), { uid: NON_MEMBER.uid, email: "x@x.com", storeId: STORE_ID, addedAt: Date.now(), addedByEmail: "x@x.com" }));
  });
  it("cannot read anyone's chat", async () => {
    await assertFails(getDoc(doc(asAnon(), "chatConversations", `${STORE_ID}__${MEMBER.uid}`, "messages", "00000002")));
  });
});

describe("signed-in NON-member: denied everywhere (a valid login alone is not authorization)", () => {
  for (const { col, id } of BUSINESS_COLLECTIONS) {
    it(`cannot read ${col}`, async () => {
      await assertFails(getDoc(doc(asNonMember(), col, id)));
    });
  }
  it("cannot write a business document either", async () => {
    await assertFails(setDoc(doc(asNonMember(), "customers", "new"), { name: "x" }));
  });
  it("cannot grant itself membership by writing its own storeMembers doc", async () => {
    await assertFails(
      setDoc(doc(asNonMember(), "storeMembers", NON_MEMBER.uid), {
        uid: NON_MEMBER.uid,
        email: NON_MEMBER.email,
        storeId: STORE_ID,
        addedAt: Date.now(),
        addedByEmail: NON_MEMBER.email,
      })
    );
  });
  it("can read only its own (nonexistent) membership doc, never another's", async () => {
    // Reading one's own doc when it doesn't exist is allowed by the rule (returns not-found, not permission-denied);
    // reading someone ELSE's doc is denied regardless of whether that doc exists.
    await assertSucceeds(getDoc(doc(asNonMember(), "storeMembers", NON_MEMBER.uid)));
    await assertFails(getDoc(doc(asNonMember(), "storeMembers", MEMBER.uid)));
  });
  it("counters and operations stay closed even to a signed-in account", async () => {
    await assertFails(getDoc(doc(asNonMember(), "counters", "invoiceCounter")));
    await assertFails(getDoc(doc(asNonMember(), "operations", "op1")));
  });
  it("cannot read another account's chat, even its own nonexistent conversation", async () => {
    await assertFails(getDoc(doc(asNonMember(), "chatConversations", `${STORE_ID}__${MEMBER.uid}`, "messages", "00000002")));
  });
});

describe("approved member: real-time reads work, direct writes never do", () => {
  for (const { col, id } of BUSINESS_COLLECTIONS) {
    it(`can read ${col} (single doc and collection query)`, async () => {
      await assertSucceeds(getDoc(doc(asMember(), col, id)));
      await assertSucceeds(getDocs(collection(asMember(), col)));
    });
  }

  it("cannot alter a product, customer, invoice, log, or payment directly — no matter how well-formed the write", async () => {
    for (const { col, id, write } of BUSINESS_COLLECTIONS) {
      await assertFails(updateDoc(doc(asMember(), col, id), write));
    }
  });
  it("cannot create a new business document directly either", async () => {
    await assertFails(setDoc(doc(asMember(), "invoices", "forged"), { invoiceNumber: "9999", total: 1000000, paymentStatus: "paid" }));
  });
  it("cannot delete a business document directly", async () => {
    await assertFails(deleteDoc(doc(asMember(), "invoices", "inv1")));
  });

  it("counters and operations (the idempotency ledger) are closed even to a member — no legitimate client need", async () => {
    await assertFails(getDoc(doc(asMember(), "counters", "invoiceCounter")));
    await assertFails(updateDoc(doc(asMember(), "counters", "invoiceCounter"), { value: 1 }));
    await assertFails(getDoc(doc(asMember(), "operations", "op1")));
  });

  it("can read its OWN membership doc but not another member's, and cannot write either (no self-escalation, no altering audit metadata)", async () => {
    await assertSucceeds(getDoc(doc(asMember(), "storeMembers", MEMBER.uid)));
    await assertFails(getDoc(doc(asMember(), "storeMembers", OTHER_MEMBER.uid)));
    await assertFails(updateDoc(doc(asMember(), "storeMembers", MEMBER.uid), { storeId: "other-store" }));
    await assertFails(setDoc(doc(asMember(), "storeMembers", NON_MEMBER.uid), { uid: NON_MEMBER.uid, email: "x@x.com", storeId: STORE_ID, addedAt: Date.now(), addedByEmail: MEMBER.email }));
  });

  it("cannot read ANOTHER member's chat — chat stays private per account even though business data is shared", async () => {
    await assertFails(getDoc(doc(asOtherMember(), "chatConversations", `${STORE_ID}__${MEMBER.uid}`, "messages", "00000002")));
    await assertFails(getDocs(collection(asOtherMember(), "chatConversations", `${STORE_ID}__${MEMBER.uid}`, "messages")));
  });
  it("CAN read its own chat", async () => {
    await assertSucceeds(getDoc(doc(asMember(), "chatConversations", `${STORE_ID}__${MEMBER.uid}`, "messages", "00000002")));
  });
  it("cannot write to its own chat directly — even the owner only reads; the server (Admin SDK) writes", async () => {
    await assertFails(setDoc(doc(asMember(), "chatConversations", `${STORE_ID}__${MEMBER.uid}`, "messages", "00000099"), { role: "user", content: "forged", order: 99 }));
  });
});

describe("B3 — revoking membership also cuts off direct SDK reads of that account's own chat transcript (it can contain business data)", () => {
  it("a member who is removed from storeMembers can no longer read their OWN past chat, directly via the SDK; reauthorization restores it immediately, with nothing to recreate", async () => {
    // Still a member: reads its own chat fine (baseline, same doc seeded in beforeEach).
    await assertSucceeds(getDoc(doc(asMember(), "chatConversations", `${STORE_ID}__${MEMBER.uid}`, "messages", "00000002")));

    // Revoked (the owner's script deletes the storeMembers doc) — the SAME account, SAME conversation, now denied.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), "storeMembers", MEMBER.uid));
    });
    await assertFails(getDoc(doc(asMember(), "chatConversations", `${STORE_ID}__${MEMBER.uid}`, "messages", "00000002")));
    await assertFails(getDocs(collection(asMember(), "chatConversations", `${STORE_ID}__${MEMBER.uid}`, "messages")));
    // Business data is denied too, for the same (already-covered) reason — confirms revocation is total, not partial.
    await assertFails(getDoc(doc(asMember(), "products", "p1")));

    // Reauthorized (added back) — access returns immediately; the conversation document was never touched or recreated.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "storeMembers", MEMBER.uid), { uid: MEMBER.uid, email: MEMBER.email, storeId: STORE_ID, addedAt: Date.now(), addedByEmail: "admin@example.com" });
    });
    await assertSucceeds(getDoc(doc(asMember(), "chatConversations", `${STORE_ID}__${MEMBER.uid}`, "messages", "00000002")));
  });
});

describe("a store context mismatch is rejected, not silently granted (single-store guard)", () => {
  it("a membership doc for a DIFFERENT storeId does not grant access", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "storeMembers", "wrong-store-user"), { uid: "wrong-store-user", email: "x@x.com", storeId: "some-other-store", addedAt: 1, addedByEmail: "a@x.com" });
    });
    const asWrongStore = env.authenticatedContext("wrong-store-user", { email: "x@x.com" }).firestore();
    await assertFails(getDoc(doc(asWrongStore, "products", "p1")));
  });
});

describe("the Phone store's data (stores/phone/…) — readable by members only, never writable from a browser", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "stores", "phone", "invoices", "pinv1"), { invoiceNumber: "1000", customerName: "Anh Tuấn", total: 700, createdAt: 1 });
      await setDoc(doc(db, "stores", "phone", "products", "pp1"), { name: "iPhone 15", defaultPrice: 700, createdAt: 1 });
      await setDoc(doc(db, "stores", "phone", "counters", "invoiceCounter"), { value: 1000 });
      await setDoc(doc(db, "stores", "evil", "invoices", "x1"), { invoiceNumber: "1", createdAt: 1 });
      await setDoc(doc(db, "storeMembers", "wholesale-only"), { uid: "wholesale-only", email: "w@x.com", storeId: STORE_ID, stores: ["main"], addedAt: 1, addedByEmail: "a@x.com" });
    });
  });

  it("a member reads the Phone store's business data", async () => {
    await assertSucceeds(getDoc(doc(asMember(), "stores", "phone", "invoices", "pinv1")));
    await assertSucceeds(getDocs(collection(asMember(), "stores", "phone", "products")));
  });

  it("non-members, signed-out visitors and members limited to Wholesale can't read it", async () => {
    await assertFails(getDoc(doc(asNonMember(), "stores", "phone", "invoices", "pinv1")));
    await assertFails(getDoc(doc(asAnon(), "stores", "phone", "invoices", "pinv1")));
    const asWholesaleOnly = env.authenticatedContext("wholesale-only", { email: "w@x.com" }).firestore();
    await assertFails(getDoc(doc(asWholesaleOnly, "stores", "phone", "invoices", "pinv1")));
    await assertSucceeds(getDoc(doc(asWholesaleOnly, "invoices", "inv1")));
  });

  it("internal collections inside a store and unknown stores stay closed", async () => {
    await assertFails(getDoc(doc(asMember(), "stores", "phone", "counters", "invoiceCounter")));
    await assertFails(getDoc(doc(asMember(), "stores", "evil", "invoices", "x1")));
  });

  it("no browser write is allowed, even by a member", async () => {
    await assertFails(setDoc(doc(asMember(), "stores", "phone", "invoices", "new1"), { total: 1 }));
    await assertFails(updateDoc(doc(asMember(), "stores", "phone", "invoices", "pinv1"), { total: 0 }));
    await assertFails(deleteDoc(doc(asMember(), "stores", "phone", "products", "pp1")));
  });
});
