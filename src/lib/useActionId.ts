"use client";

import { useCallback, useRef } from "react";
import { newOperationId } from "./businessApi";

/**
 * One stable operationId per intended user action (opening a create/edit modal, opening the payment dialog),
 * reused across every RETRY of that same action, and replaced only when a genuinely NEW action begins. This is
 * what makes a lost-response retry safe end to end: if her "Save" commits on the server but the reply never
 * reaches the browser, retrying reuses the same key, so the server's idempotency ledger (src/lib/server/
 * businessStore.ts) returns the original result instead of creating a second invoice or payment. Opening the
 * form/dialog again for a deliberately new action gets a fresh key, exactly as it should.
 *
 * A page with more than one independent action (e.g. the invoice detail page's edit form AND its payment dialog)
 * uses one instance of this hook per action — they must not share a single id.
 */
export function useActionId() {
  const idRef = useRef<string | null>(null);

  /** Call when a NEW action begins (opening a create/edit modal, opening the payment dialog) — assigns a fresh id. */
  const start = useCallback((): string => {
    idRef.current = newOperationId();
    return idRef.current;
  }, []);

  /** Call on every submit attempt of the CURRENT action, including retries — stable until start() runs again. */
  const current = useCallback((): string => {
    if (!idRef.current) idRef.current = newOperationId(); // defensive: a submit before any explicit start()
    return idRef.current;
  }, []);

  return { start, current };
}
