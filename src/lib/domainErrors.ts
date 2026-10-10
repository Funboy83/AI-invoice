/** Business-rule failure (bad id, missing record, invalid amount) — safe to report to the AI/user as-is. */
export class DomainError extends Error {}
export class NotFoundError extends DomainError {}

/** Input failed server-side validation (bad shape, out-of-range money/quantity, unknown status, missing reason). */
export class ValidationError extends DomainError {}

/**
 * An operationId was reused for a call whose meaningful input differs from the call that originally used it.
 * A stable retry key is only safe to replay when it is truly the SAME action being retried — if the same key
 * were ever reused for a different one (a bug, or two unrelated actions colliding), blindly returning the
 * first call's cached result would silently apply the wrong outcome to the second. This fails loudly instead.
 */
export class OperationConflictError extends DomainError {}
