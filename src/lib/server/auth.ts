import { ConfigError, getAdminAuth, getAdminDb } from "./firebaseAdmin";
import { isMember, membershipStoreId } from "./membership";
import { DEFAULT_STORE_ID, STORE_HEADER, isStoreId } from "@/lib/stores";

export interface AuthedUser {
  uid: string;
  email: string;
  /** The business store this request acts on (src/lib/stores.ts) — every read and write is limited to it. */
  storeId: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/** The membership list's app id (see membership.ts). Doors with no store picker (Telegram) use DEFAULT_STORE_ID. */
export function currentStoreId(): string {
  return membershipStoreId();
}

/**
 * The store a browser request is for, from the X-Store-Id header. A request with no header is for Wholesale (the
 * only store older app versions know about); an unknown value is refused, never mapped to some other store.
 */
export function requestedStoreId(req: Request): string {
  const raw = req.headers.get(STORE_HEADER)?.trim();
  if (!raw) return DEFAULT_STORE_ID;
  if (!isStoreId(raw)) throw new HttpError(400, "Cửa hàng không hợp lệ.");
  return raw;
}

/**
 * Verifies the Firebase ID token in `Authorization: Bearer …`, then checks `storeMembers/{uid}` — the single,
 * administrator-controlled membership source (see membership.ts) — LIVE, on every call. This is deliberately not
 * cached in the token: a valid, unexpired ID token from an account that was just removed from storeMembers is
 * rejected immediately, not after the token's remaining lifetime. Anyone can create a Firebase Auth account on an
 * open project, so a valid token alone is never sufficient authorization — membership is what grants access, to
 * chat AND to every business read/write this server performs on the caller's behalf.
 */
export async function authenticate(req: Request): Promise<AuthedUser> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Bạn cần đăng nhập để tiếp tục.");

  let decoded;
  try {
    decoded = await getAdminAuth().verifyIdToken(token);
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new HttpError(401, "Phiên đăng nhập đã hết hạn — hãy đăng nhập lại.");
  }
  const email = (decoded.email ?? "").toLowerCase();
  const storeId = requestedStoreId(req);
  if (!email || !(await isMember(getAdminDb(), decoded.uid, storeId))) {
    throw new HttpError(403, "Tài khoản này chưa được cấp quyền truy cập cửa hàng.");
  }

  return { uid: decoded.uid, email, storeId };
}

