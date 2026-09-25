import type { Firestore } from "firebase-admin/firestore";

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
  storeId: string;
  addedAt: number;
  /** Email of the administrator who ran the bootstrap script, for audit purposes — not itself a security check. */
  addedByEmail: string;
}

const MEMBERS_COLLECTION = "storeMembers";

export function memberDocId(uid: string): string {
  return uid;
}

/**
 * True iff `uid` has a membership doc for `storeId`. A doc that exists but names a DIFFERENT storeId is treated as
 * not-a-member (defends against a stale/misconfigured doc silently authorizing someone into the wrong store) —
 * this app supports exactly one configured store, never multiple, so any mismatch is a configuration error, not a
 * grant.
 */
export async function isMember(db: Firestore, uid: string, storeId: string): Promise<boolean> {
  if (!uid || !storeId) return false;
  const snap = await db.collection(MEMBERS_COLLECTION).doc(memberDocId(uid)).get();
  if (!snap.exists) return false;
  const data = snap.data() as Partial<MemberDoc> | undefined;
  return data?.storeId === storeId;
}
