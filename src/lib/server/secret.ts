import { timingSafeEqual } from "node:crypto";

/** Constant-time check of `Authorization: Bearer <secret>` for server-to-server endpoints (cron sweep, continuation). */
export function bearerMatches(req: Request, secret: string): boolean {
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
