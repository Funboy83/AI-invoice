import { ConfigError, getAdminAuth, getAdminDb } from "./firebaseAdmin";
import { isMember } from "./membership";

export interface AuthedUser {
  uid: string;
  email: string;
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

export function currentStoreId(): string {
  return process.env.APP_STORE_ID?.trim() || "main";
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
  const storeId = currentStoreId();
  if (!email || !(await isMember(getAdminDb(), decoded.uid, storeId))) {
    throw new HttpError(403, "Tài khoản này chưa được cấp quyền truy cập cửa hàng.");
  }

  return { uid: decoded.uid, email, storeId };
}
