import type { Firestore } from "firebase-admin/firestore";
import { isStoreId } from "@/lib/stores";

/**
 * The ONE administrator-controlled source of "who may use this store" — a Firestore document per uid, checked live
 * (Admin SDK, no token-claim caching) on every authenticated server request AND by Firestore rules for direct
 * browser reads. Never written by any client or HTTP endpoint: only `scripts/manage-members.mjs`, run locally by
 * whoever holds the service-account key, creates or deletes these docs. Revocation is immediate — there is no
 * "wait up to an hour for the token to refresh" gap, because nothing here is baked into the ID token.
 */
export interface MemberDoc {
  uid: string;
  email: string;
  /** The app this membership is for (membershipStoreId()), NOT which business store — see `stores`. */
  storeId: string;
  /** Optional: limits this member to these business stores (src/lib/stores.ts). Absent = every store. */
  stores?: string[];
  addedAt: number;
  /** Email of the administrator who ran the bootstrap script, for audit purposes — not itself a security check. */
  addedByEmail: string;
}

const MEMBERS_COLLECTION = "storeMembers";

export function memberDocId(uid: string): string {
  return uid;
}

/**
 * Which app this membership list is for: every member doc carries this id in `storeId` (APP_STORE_ID, default
 * "main"; must match STORE_ID() in firestore.rules). A doc naming a DIFFERENT id is a stale/misconfigured doc and
 * never grants anything.
 */
export function membershipStoreId(): string {
  return process.env.APP_STORE_ID?.trim() || "main";
}

/**
 * True iff `uid` may use the business store `storeId` (one of src/lib/stores.ts). A member of this app may use
 * every store it runs (Wholesale and Phone store share one login) unless their doc lists `stores: [...]`, which
 * then limits them to just those. An unknown store id is always refused — a forged or mistyped store never
 * passes, and never falls back to another store.
 */
export async function isMember(db: Firestore, uid: string, storeId: string): Promise<boolean> {
  if (!uid || !isStoreId(storeId)) return false;
  const snap = await db.collection(MEMBERS_COLLECTION).doc(memberDocId(uid)).get();
  if (!snap.exists) return false;
  return grantsStore(snap.data() as Partial<MemberDoc> | undefined, storeId);
}

function grantsStore(data: Partial<MemberDoc> | undefined, storeId: string): boolean {
  if (data?.storeId !== membershipStoreId()) return false;
  if (Array.isArray(data.stores)) return data.stores.includes(storeId);
  return true;
}

/**
 * The store member with this login email, or null. Used by doors that identify a person by email rather than by a
 * Firebase sign-in (Telegram, the outside-AI API key), so they are checked against the same live storeMembers list.
 */
export async function memberByEmail(db: Firestore, email: string, storeId: string): Promise<{ uid: string; email: string; storeId: string } | null> {
  const wanted = email.trim().toLowerCase();
  if (!wanted || !isStoreId(storeId)) return null;
  const snap = await db.collection(MEMBERS_COLLECTION).where("email", "==", wanted).limit(5).get();
  const doc = snap.docs.find((d) => grantsStore(d.data() as Partial<MemberDoc>, storeId));
  if (!doc) return null;
  return { uid: (doc.data().uid as string) || doc.id, email: wanted, storeId };
}
