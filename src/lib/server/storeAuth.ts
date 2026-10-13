import { authenticate, type AuthedUser } from "./auth";
import { runInStore } from "./storeContext";

/**
 * authenticate(), then runs `fn` inside the authenticated user's store (storeContext.ts), so every business read
 * and write it makes is limited to that one store. Every /api/business/* route goes through this.
 */
export async function inAuthedStore<T>(req: Request, fn: (user: AuthedUser) => Promise<T>): Promise<T> {
  const user = await authenticate(req);
  return runInStore(user.storeId, () => fn(user));
}
