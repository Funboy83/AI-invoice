import { NextResponse } from "next/server";
import { HttpError } from "./auth";
import { ConfigError } from "./firebaseAdmin";
import { NotFoundError, ValidationError, OperationConflictError, DomainError } from "@/lib/domainErrors";

/** Maps server errors to JSON responses; unknown errors are logged and never leak internals to the client. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof ConfigError) return NextResponse.json({ error: err.message, code: "not_configured" }, { status: 503 });
  // Order matters: NotFoundError/ValidationError/OperationConflictError extend DomainError, so check them first.
  if (err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
  if (err instanceof ValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
  if (err instanceof OperationConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
  if (err instanceof DomainError) return NextResponse.json({ error: err.message }, { status: 400 });
  console.error("[chat] unexpected error", err);
  return NextResponse.json({ error: "Có lỗi ở máy chủ — thử lại sau ít phút nhé." }, { status: 500 });
}

/** Runs background work after the response is sent (Next's `after` → Vercel waitUntil). Errors are logged, never thrown. */
export function logged<T>(label: string, work: () => Promise<T>): () => Promise<void> {
  return async () => {
    try {
      await work();
    } catch (err) {
      console.error(`[chat] ${label} failed`, err);
    }
  };
}
