# AI-invoice — durable operating policy

**Version:** 1.0
**Effective:** 2026-09-25
**Source of record:** GitHub issue [#1](https://github.com/Funboy83/AI-invoice/issues/1), owner comment
["Direction: ChatGPT connection, existing in-app chatbot unchanged"](https://github.com/Funboy83/AI-invoice/issues/1#issuecomment-5828202017)
(2026-09-25T06:51:01Z). This file is the durable, versioned record the owner asked for — the issue comment remains
the historical origin, but *this document*, not conversation history, is what future work (starting with the
planned OAuth-authenticated GPT Actions connector) is expected to implement against and be reviewed against.

**Scope:** every surface that lets a person or an AI act on this app's business data — today, the in-app AI
secretary (`src/lib/ai/tools.ts` + `src/app/api/chat/*`) and the manual UI (`src/app/*/page.tsx` +
`src/app/api/business/*`); in the future, the GPT Actions connector once it exists. A rule below that isn't yet
enforced by code says so explicitly, so this document can't be mistaken for a description of what already ships.

## The rules

1. **Save immediately when the data is clear.** Save a new invoice as soon as the essential customer/product/
   quantity/price details are clear and non-conflicting; report back the saved invoice number, totals, status and
   a link to it. If essential data is missing or conflicting, ask instead of guessing. Never claim success before
   the write has actually committed.
2. **Explicit approval before anything sensitive.** Payments, price changes, voids, credits and refunds require
   explicit human approval before they happen — not an inference that the user probably meant it. Once any GPT
   Actions endpoint exposes a sensitive operation, it must be marked `consequential: true` in the OpenAPI schema
   *and* the server must independently confirm the exact proposed operation itself; a `confirmed: true` flag
   supplied by the model is never treated as proof of approval on its own.
3. **No permanent deletion of business records.** Invoices and payments are never hard-deleted by any surface.
4. **Payments are preserved; corrections are additive and auditable.** A correction links back to the original
   record rather than erasing it. Archiving or hiding a record never changes computed financial balances.
5. **New surfaces start narrow.** A new integration (the planned GPT Actions connector, or any future one) does
   not expose sensitive mutation, deletion, credit/refund or archive operations in its first version. This keeps
   the initial scope bounded and avoids standing up a second, parallel accounting subsystem.
6. **The policy lives in enforced places, not just conversation history.** This document, the GPT Actions
   instructions/OpenAPI configuration once that connector exists, and the adapter/service-layer checks plus their
   regression tests are all expected to encode these rules — a decision recorded only in an issue comment or a
   chat transcript does not count as having been applied.
7. **Ordinary, non-sensitive actions may skip repeated confirmation.** An ordinary `createInvoice` call may be
   marked `consequential: false`, which lets the user choose "Always allow" for it in ChatGPT's own consent UI.
   ChatGPT's platform may still require its own initial or periodic consent regardless of this flag — never
   promise a user a zero-prompt experience globally; that promise is not this app's to make.

## What already enforces which rule, today

| Rule | Enforced by | Notes |
|---|---|---|
| 1 (save when clear; never claim success before commit) | `src/lib/ai/tools.ts`'s `createInvoiceDraft`, `src/lib/server/businessStore.ts`'s `createInvoice` (returns only after the transaction commits) | Unchanged by this task. The AI's existing "incomplete draft" behavior (asks for missing quantity/price rather than guessing) is exactly rule 1's "ask if missing" case, and is explicitly preserved by the B2 fix in this task (`sanitizeInvoiceItems` in `src/lib/invoiceMath.ts` keeps quantity/price of exactly 0 legal). |
| 2 (approval before payments/price changes/voids) | `src/lib/ai/systemPrompt.ts` (existing chatbot instructions — **unchanged by this task**); `businessStore.ts`'s financial validation (rejects invalid amounts, but does not itself gate on approval — approval is a conversational/UI concern for the existing chatbot today) | The `consequential`/server-side-confirmation mechanism this rule describes applies to the **planned GPT Actions connector**, which does not exist yet. Nothing to implement here now. |
| 3 (no permanent deletion) | Structural: no code path deletes an invoice or a payment document. `updateInvoiceWithLog`'s `status: "void"` is the only "removal," and it is a state change, not a delete, so it is inherently reversible and auditable. | `src/lib/store.ts`'s `deleteProduct` exists but is legacy/unreachable code (see that file's header comment) and concerns a product catalog entry, not an invoice or a payment. |
| 4 (payments preserved, corrections auditable, archiving doesn't change balances) | `recordPayment` only ever adds a payment record and increases `amountPaid`; nothing subtracts or deletes one. Every invoice/payment mutation writes an audit-log entry with a before/after snapshot (`invoiceLogs`, Task A's serialization applies here too). | Unchanged by this task. |
| 5 (new surfaces start narrow) | **Owner decision 2026-10-17:** the outside-AI API/MCP surface (`src/lib/server/externalApi.ts`, `adminTools.ts`, `/api/v1/tools`, `/api/mcp`) now covers everything the app's pages can do, like an admin (payments, invoice edits and voids, delivery pricing, customers, products, vendors, purchases, vendor payments, cancelling purchases). Its allow-list is tested in `externalApi.test.ts`. | Rule 2 still holds there: every write goes through a preview and a server-stored one-time token (`confirmAction`), so the server itself confirms the exact operation and what is saved is exactly what was previewed. Payments can't exceed what is owed. Rule 3 still holds: nothing is permanently deleted (voids and cancels are state changes). New features must ship with their tools (CONTRIBUTING.md). |
| 6 (policy lives in enforced places) | This document, plus the regression tests this task adds for B1/B2/B3 (`src/lib/server/businessStore.test.ts`, `src/app/api/business/business.routes.test.ts`, `src/lib/ai/createInvoiceDraft.test.ts`, `src/test/emulator/rules.emulator.test.ts`). | The GPT Actions instructions/OpenAPI half of this rule is future work. |
| 7 (ordinary actions may skip repeated confirmation) | Not yet applicable — no GPT Actions `consequential` flags exist yet (no connector). | Recorded here for the next task. |

## What this document does not authorize

This is a policy record, not an implementation. It does not itself build the GPT Actions connector, change the
existing chatbot's UI, model, prompts or workflow, or alter any live configuration — those remain out of scope for
the task that added this file (see the issue for the current task boundaries at the time this was written).
