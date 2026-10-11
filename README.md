# Invoice AI — Virtual Secretary

A simple, modern invoicing web app with Firestore as the database and an AI assistant ("virtual secretary") that can create invoices, manage inventory, and manage customers through chat — in addition to full manual CRUD via the UI.

Operating rules for how this app (and any future integration, such as the planned GPT Actions connector) is allowed
to act on business data are recorded in [`docs/OPERATING_POLICY.md`](docs/OPERATING_POLICY.md) — the versioned,
authoritative reference; changes there should always come with matching enforcement and regression tests, not just
an updated document.

## Features

- **Dashboard** — revenue, invoice count, product count, recent invoices.
- **Invoices** — manual creation UI + AI chat creation, editable with a required reason, full audit log (before/after) for every AI or manual edit.
- **Inventory** — manual CRUD; stock tracking is opt-in per product (leave quantity blank to not track it). A tracked product's stock is automatically deducted once an invoice actually commits (goes from draft to unpaid/partial/paid — including a manually-created invoice, which starts unpaid immediately), and is restored if the invoice is voided or a line item quantity is reduced/removed. Selling past zero is allowed (never blocks a sale) and surfaces a stock warning instead.
- **Customers** — manual CRUD; auto-created by the AI when invoicing a new customer.
- **AI secretary** (bottom-right chat button) — can:
  - Parse natural language requests to build invoices, computing line totals and the grand total.
  - Ask you for missing quantity/price before adding a line item.
  - Search inventory before creating a new item, and **must ask for confirmation** if a similar item name already exists, instead of silently creating a duplicate.
  - Offer to remember a fuzzy-matched wording as an alias for next time.
  - Edit invoices, always writing a reasoned entry to the audit log.

## Setup

1. **Install dependencies** (already done if you're reading this after scaffolding):
   ```bash
   npm install
   ```
2. **Create a Firebase project** at https://console.firebase.google.com, enable **Firestore Database** (start in test mode for local development), then add a Web App and copy its config values.
3. **Copy the env template** and fill in your Firebase + Anthropic values:
   ```bash
   cp .env.local.example .env.local
   ```
   - `NEXT_PUBLIC_FIREBASE_*` — from Firebase Console > Project settings > General > Your apps.
   - `ANTHROPIC_API_KEY` — required for the AI chat assistant (`/api/chat`), which calls Claude (`ANTHROPIC_MODEL`, defaults to `claude-sonnet-5`). Without it, the rest of the app (manual CRUD) still works, but chat will show a configuration error.
4. **Run the dev server**:
   ```bash
   npm run dev
   ```
   Open http://localhost:3000.

## Access control

One shared store. In practice this household uses **one shared Firebase Auth account** for both people — the
membership mechanism itself supports enrolling more than one uid, but nothing here assumes more than one, and
release/setup steps below are written for enrolling that one existing account, not for creating new ones. Everyone
else is locked out — enforced in two places that both check the SAME source, so they can't drift apart:

- **`storeMembers/{uid}`** (Firestore) is the one administrator-controlled membership source. A doc `{uid, email, storeId, addedAt, addedByEmail}` grants that uid access to chat AND every business page/mutation; no doc, no access. **Nobody can write it except `scripts/manage-members.mjs`** (Admin SDK, run locally with the service-account key) — not the app, not any API route, not the account itself.
- **`firestore.rules`** requires `isMember()` (checks `storeMembers/{request.auth.uid}` live) for every business-collection read, and denies ALL direct browser writes to business data — `write: if false` everywhere except each user's own `storeMembers` doc, which is read-only even to its owner. `counters` and `operations` (the idempotency ledger) are closed entirely; nothing in the UI ever needs to read them.
- **`src/lib/server/auth.ts`** (`authenticate()`) checks the *exact same* `storeMembers/{uid}` doc, live, Admin-SDK, on every authenticated server request — chat and every `/api/business/*` route. This is a real-time check, not baked into the ID token, so revoking access takes effect on her very next request, not after the token's remaining lifetime.
- **`src/lib/server/agentRunner.ts`** re-checks membership before every claim of a background job AND before every subsequent model turn and tool-execution wave within one attempt — so a revocation mid-job stops the *next* mutation without touching or repeating anything already committed.

### Granting / revoking access

```bash
# person must already have a Firebase Auth account (Console > Authentication > Users, or they sign up once)
npm run members:add -- her@example.com
npm run members:remove -- her@example.com
npm run members:list
```

Needs `FIREBASE_SERVICE_ACCOUNT_JSON` in `.env.local` (same key the server uses). Never prints it. See `scripts/manage-members.mjs`.

### Where each kind of access lives now

| | Reads | Writes |
|---|---|---|
| Business pages (products/customers/invoices) | Client SDK, real-time (`onSnapshot`), gated by `firestore.rules` | `/api/business/*` (authenticated, membership-checked, server-side validated) → `src/lib/server/businessStore.ts` (Admin SDK) |
| AI tool calls | `src/lib/server/businessStore.ts` directly (server-only, already trusted) | same |
| Chat | Client SDK, real-time, owner **and current member** (`chatConversations/.../messages`) | `/api/chat/*` → `src/lib/server/chatJobs.ts` (Admin SDK) |

`src/lib/store.ts` (client SDK) still exists for the read side and is unchanged there; its write functions are kept only because `src/lib/invoiceSerialization.test.ts` (Task A's regression test) exercises them directly — they are no longer reachable from the running app once rules are deployed.

### Retry safety and financial validation

- **Manual mutations use one stable retry key per intended action**, not a fresh one per HTTP call. `src/lib/useActionId.ts` hands each page's create/edit/payment flow one id, generated when that action starts (opening the modal/dialog) and reused on every retry of it; `src/lib/businessApi.ts`'s functions now *require* that id rather than generating their own. If a request commits on the server but its response never reaches the browser, retrying reuses the same key, and the server (`runOnce` in `src/lib/server/businessStore.ts`) returns the original result instead of creating a second invoice or payment. Opening the form again for a genuinely new action gets a fresh key.
- **A reused key is checked against what it was originally used for.** The idempotency ledger (`operations/{id}`) now stores a fingerprint of the meaningful input alongside the cached result; a replay whose input doesn't match throws `OperationConflictError` (HTTP 409) instead of silently returning an unrelated earlier result.
- **Financial invariants are enforced once, at the one boundary every write goes through** (`src/lib/server/businessStore.ts`, called by both `/api/business/*` and the AI's tool calls) — never-negative, never-`NaN`/`Infinity`, bounded quantities and prices; `lineTotal` is always recomputed from `quantity × price`, never trusted from the caller. A legitimate AI "incomplete draft" line (quantity and/or price exactly `0`, `incomplete: true`) is explicitly preserved — only negative or non-finite values are rejected, and rejection means no invoice/counter/log/payment write happens at all, not a partial one.

## Durable AI chat

Chat requests are **background jobs**, so she can close the tab, reload, or take a phone call and find the result when she comes back.

- `POST /api/chat` verifies her Firebase login and current store membership (see Access control above), stores the message and a job in **one Firestore transaction**, returns `202 {jobId}`, then runs the job with Next's `after()` (Vercel `waitUntil`). Retrying the same `requestId` returns the same job.
- The job is a **checkpointed state machine** in Firestore (`chatJobs/*`): each model response is saved *before* its tools run, each tool result *after*. A worker holds a 60s **lease** (heartbeat every 20s); if it dies, any later run takes over and continues from the checkpoint. Every write is fenced by the lease.
- Every data-changing tool call has a stable **operation id** (`jobId__toolUseId`). `store.ts` checks/writes the `operations/{id}` ledger in the **same transaction** as the invoice/payment/product write, so replays never duplicate. Invoice numbers are allocated inside the invoice-create transaction.
- Jobs in one conversation run **in order**; a follow-up sent while a task runs is accepted immediately and starts when the earlier one finishes.
- States: `sending` (in the app) → `accepted` → `running` → `waiting_for_input` | `completed` | `failed`. A failed job keeps its checkpoints; **Thử lại** continues without repeating finished work.
- `force=true` on createProduct/createCustomer is honoured only in a job that is her reply to a question the AI asked (`requestUserInput`).
- Recovery: the app calls `POST /api/chat/jobs/:id/resume` on open, on focus and every 30s while a job is pending. For recovery while nobody has the app open, call `GET /api/cron/chat-jobs` every minute with `Authorization: Bearer $CRON_SECRET` (Vercel Cron on a Pro plan — Hobby only allows daily crons — or any external scheduler).

### Speed, time budget and recovery

- **Reads happen once per tool call, not once per line item.** `createInvoiceDraft` loads the catalog once and this customer's invoice history once (fresh every time — there is no cross-request cache, so prices are never stale), and looks every product's last price up in memory. Price precedence is unchanged: explicit price > customer's last non-void price > catalog default > missing (saved as an incomplete draft).
- **Firestore indexes: none required.** The history query is a single-field equality (`invoices.customerId ==`), which Firestore indexes automatically, and product ids are batched with `documentId() in [...]` (30 per query). Ordering is done in memory on purpose. Only if you later add `orderBy("createdAt")` or a `limit()` to that query would you need a composite index on `invoices (customerId ASC, createdAt DESC)`.
- **Independent read-only tool calls of one model turn run concurrently (max 4)**; every write (and `requestUserInput`) runs alone, in order, as a barrier. Results are recorded and sent to the model in the model's original order, and a wave is checkpointed in one write.
- **One time budget per invocation** (`INVOCATION_LIMIT_MS` = the routes' `maxDuration`, 300s). A model call gets `min(60s, time left − 25s)` and is not started if under 15s would remain; retries and backoff happen only if another attempt still fits. The SDK's own retries are off — retries are ours and budgeted.
- **Out of time → hand-off, not abandonment.** The invocation releases the job (lease intact, checkpoints kept) and immediately calls `POST /api/chat/jobs/:id/continue` on its own deployment (authenticated with `CRON_SECRET`), which starts a fresh invocation with a full budget. This works with the browser closed and needs no scheduler. It needs `CRON_SECRET` set; the target URL comes from `APP_BASE_URL`, else Vercel's `VERCEL_PROJECT_PRODUCTION_URL` (production) / `VERCEL_URL` (preview) — never from request headers. If Vercel Deployment Protection blocks preview self-calls, enable "Protection Bypass for Automation" (Vercel injects `VERCEL_AUTOMATION_BYPASS_SECRET`, which is sent automatically). If the hand-off cannot be sent, the job stays queued and is picked up by the app (open/focus/every 30s) or a scheduler sweep. A job that hands itself off more than 10 times is failed for a manual retry (loop guard).
- **What still needs a scheduler:** an invocation that is *killed* (crash, platform incident) cannot hand off. Recovery then needs either the app to be opened or `GET /api/cron/chat-jobs` to be called every minute. **This repository contains no `vercel.json`/`vercel.ts` (Vercel Cron is configured only there), and no CI schedule, so no scheduler is deployed today.** See the checklist below.
- **Timing logs** (one JSON line per event, `"src":"chat-job"`, visible in Vercel logs): `accepted` (commit ms), `job_claimed` (`queueMs` = acceptance → worker start), `model_call` (ms, token usage, stop reason, tool-use count), `model_retry`, `tool_exec` / `tool_wave` / `tool_phase` (`draft_reads`, `invoice_commit`), `checkpoint` (kind, ms), `worker_retry`, `job_deferred`, `hand_off`, `continuation`, and `job_finished` (totals, `finalReplyMs`, tokens, retries). Only job ids, durations, counts, token usage and short codes are logged; the logger redacts anything else (order text, names, error messages), and tests enforce it.
- **Measuring:** `npm run bench:orders` runs 1/5/10-item orders through the real runner with the **real model** (uses your `ANTHROPIC_API_KEY`; costs a few cents) against an in-memory database, and prints model vs tool vs checkpoint time. It never touches Firestore. `BENCH_SIZES`, `BENCH_REPS` and `READ_RTT_MS` tune it.

Setup checklist (none of this is automatic — see also "Release order" below):
1. Firebase Console → Authentication → enable **Email/Password**; create the account(s) that should have access.
2. Set `FIREBASE_SERVICE_ACCOUNT_JSON`, `APP_STORE_ID`, `CRON_SECRET` (see `.env.local.example`) locally and in Vercel.
3. Grant access: `npm run members:add -- her@example.com` (repeat per account — see Access control above).
4. Deploy the rules: `firebase deploy --only firestore:rules` (membership-gated reads, no direct browser writes at all — see Access control above).
5. Set `CRON_SECRET` (enables the automatic job hand-off). For recovery of *killed* invocations while nobody has the app open, also add a cron entry to a new `vercel.json` (Vercel Pro; Hobby only allows daily crons and a per-minute schedule would fail the deploy): `{"crons":[{"path":"/api/cron/chat-jobs","schedule":"* * * * *"}]}` — or call that URL every minute from any scheduler with `Authorization: Bearer $CRON_SECRET`.

Run the tests with `npm test` (in-memory Firestore fakes; never touches a real database). Run `npm run test:emulator` for **real** Firestore rules verification (needs Java + `firebase-tools`, both local devDependencies/tools — never deployed; see "Testing access control" below).

## Outside AI apps: API and MCP server

Claude, ChatGPT or a script can use the store's data through the **same tools** the in-app chat uses (`src/lib/server/externalApi.ts`, over `src/lib/ai/tools.ts`). Off unless configured:

- `AI_API_ENABLED=true`
- `AI_API_KEYS="her@example.com:<random key, 32+ letters/digits>, …"` — each key belongs to an existing store member (checked live, so `members:remove` also cuts off the key). Make a key with `openssl rand -base64 33 | tr '+/' '-_'`.

Endpoints:
- MCP (Streamable HTTP, JSON responses): `POST /api/mcp` with `Authorization: Bearer <key>`, or `POST /api/mcp/<key>` for apps whose connector screen only takes a URL (claude.ai, ChatGPT). Treat that link like a password.
- REST: `GET /api/v1/tools` (list + input schemas), `POST /api/v1/tools/<name>` with the arguments as JSON. Key in `Authorization: Bearer` or `X-API-Key`.

What it can do: read tools (customers, products, invoices, debt, unpaid, deliveries, payments, last price), plus `createInvoiceDraft` and `createDeliveryOrder`, which only **preview** and return a one-time `confirmToken`; `confirmAction` saves exactly what was previewed (30-minute expiry, a repeat returns the same invoice). Payments, edits, voids, delivery pricing and customer/product changes are not exposed (docs/OPERATING_POLICY.md rule 5).

## Testing access control

- `npm test` (fake Firestore, always run, never touches a real database): membership logic (`src/lib/server/membership.test.ts`), `authenticate()`'s header contract, every `/api/business/*` route's authorization/validation/no-partial-write behavior (`src/app/api/business/business.routes.test.ts`), and background-job revocation — three independently-necessary checks (claim-time, before-each-model-turn, before-each-tool-execution-wave) each proven by a dedicated test in `src/lib/server/agentRunner.membership.test.ts`.
- `npm run test:emulator` (opt-in, **real** Firestore emulator + the actual deployed `firestore.rules`, via `firebase emulators:exec` + `@firebase/rules-unit-testing`): anonymous and signed-in non-member denial on every business collection and on `storeMembers`/`counters`/`operations`; an approved member's reads succeed and writes are denied everywhere, including well-formed forged writes; no self-enrollment; a membership doc for the wrong `storeId` is rejected; chat stays private between two different members even though business data is shared. Needs Java 11+ locally (e.g. `brew install openjdk`, or any JDK on `PATH`/`JAVA_HOME`) — `firebase-tools` is already a devDependency. This is real rule evaluation, not a simulation.

## Data model (Firestore collections)

- `storeMembers/{uid}` — `{uid, email, storeId, addedAt, addedByEmail}`. The one access-control source (see Access control above). Written only by `scripts/manage-members.mjs`.
- `products` — inventory: name, aliases, defaultUnit, defaultPrice, cost, quantity (optional — omitted means stock isn't tracked for that product), category, barcode, notes, active.
- `customers` — name, email, phone, address.
- `invoices` — number, customerId/customerName, lineItems[], subtotal/tax/total, status, createdBy.
- `invoiceLogs` — invoiceId, actor (`ai`/`user`), action, message, before/after snapshots.
- `counters` — sequential invoice numbering. Closed to clients entirely.
- `operations` — idempotency ledger (one doc per data-changing tool call/mutation, AI or manual). Closed to clients entirely.
- `chatConversations/{store__uid}/messages|requests`, `chatJobs/{id}/steps|toolCalls` — durable chat (server-written; owner can read own messages, regardless of current membership).

## Project structure

- `src/lib/firebase.ts` — Firebase client init.
- `src/lib/store.ts` — Firestore client-SDK reads (still live) + writes (kept only for Task A's regression test — see Access control above).
- `src/lib/invoiceMath.ts`, `src/lib/domainErrors.ts` — pure totals/serialization/error types shared by `store.ts` and `businessStore.ts`, so they can't drift.
- `src/lib/server/businessStore.ts` — Admin-SDK mirror of `store.ts`'s write functions (same transactions, idempotency ledger, totals); used by `/api/business/*` and `src/lib/ai/tools.ts`.
- `src/lib/server/businessValidation.ts` — server-side input validation (money, quantities, statuses, edit reasons) for the manual mutation routes.
- `src/lib/server/membership.ts`, `auth.ts` — the one membership check, and the authenticated-request gate that uses it.
- `src/app/api/business/*` — authenticated, validated manual mutation routes (products/customers/invoices/payments).
- `src/lib/ai/tools.ts` — tool definitions + executor used by the AI assistant (Admin-SDK-backed via `businessStore.ts`).
- `src/app/api/chat/*`, `src/app/api/cron/chat-jobs`, `src/app/api/session` — accept / resume / retry / recovery / session-check endpoints.
- `src/lib/server/chatJobs.ts`, `agentRunner.ts` — durable job engine, checkpointed model/tool loop, and per-claim/per-turn membership enforcement.
- `src/lib/useAppAuth.tsx`, `src/components/RequireAuth.tsx` — the one auth/membership gate in front of every business page and the chat UI.
- `src/components/ChatPanel.tsx` — the chat UI (bottom-right "Ask AI" drawer).
- `scripts/manage-members.mjs` — CLI to grant/revoke/list store access (never reachable over HTTP).
- `src/app/*` — Dashboard, Invoices, Inventory, Customers pages.

## Release order and rollback

Nothing here is deployed by this change. This household uses **one existing shared Firebase Auth account** — there
is nothing to migrate and no new account to create; the steps below enroll that one UID and nothing else.

### Before touching anything: verify the target, not just the plan

A release rehearsed against the wrong project, or with `APP_STORE_ID` not matching the rules' `STORE_ID()` constant,
looks identical to a correct one right up until it silently locks everyone out (or, worse, grants access nobody
intended). Confirm ALL THREE of these agree before step 1:
- The **browser app** (`NEXT_PUBLIC_FIREBASE_PROJECT_ID` in the deployed environment).
- **`scripts/manage-members.mjs`** (`FIREBASE_SERVICE_ACCOUNT_JSON`'s `project_id`, and the `APP_STORE_ID` it enrolls under).
- **`firestore.rules`**'s `STORE_ID()` constant (currently hardcoded `"main"`).
If any of these three disagree, the fix is to correct the mismatch, not to proceed and see what happens.

**While the OLD wildcard rules (`allow read, write: if true`) are still live**, `storeMembers` is client-writable
by *anyone* who has the app open — nothing about the app prevents someone from writing a bogus membership doc for
themselves before rules are locked down, whether by mistake or otherwise. `npm run members:add`/`members:list` go
through the trusted Admin SDK regardless of what the rules currently say, so:

1. **Set env vars**, in Vercel: `FIREBASE_SERVICE_ACCOUNT_JSON`, `APP_STORE_ID` (if not `main`), `CRON_SECRET`. The app still runs on the OLD rules at this point — no behavior change yet.
2. **Bootstrap membership** for the one existing shared UID: `npm run members:add -- <that account's email>`. No new Firebase Auth account, no customer-data migration — this only writes one `storeMembers` doc for a UID that already exists.
3. **Deploy the app code** (this change). Business pages now call `/api/business/*`, which work immediately — they don't depend on the rules deploy (the Admin SDK they use bypasses rules entirely). Direct browser reads/writes still work under the OLD open rules too, so there is no functional outage between this step and the next. **But an already-open browser tab does not pick up new app code on its own** — deploying does not push anything to a tab that was loaded before the deploy; it keeps running whatever JavaScript it already loaded until it is reloaded or reopened. Two tabs open across this step, one refreshed and one not, can briefly be running different code against the same data — not dangerous by itself (the OLD code's direct writes still work fine under still-open rules), but worth knowing before the NEXT step.
4. **Right before deploying restrictive rules**, run `npm run members:list` and confirm it shows exactly the one expected UID/email and nothing else. This is the check that catches a bogus doc from the exposure window above, using the same trusted Admin path that will keep working regardless of what the rules say next.
5. **Ask for all open tabs/devices to be refreshed (or closed), or simply pause using the app for a minute**, then deploy `firestore.rules`: `firebase deploy --only firestore:rules`. Only after this step do direct browser writes actually get blocked and reads become membership-gated. **A tab left open from before this step, running old code that still attempts a direct write, will start failing that write** the moment rules go live (a clear permission-denied, not silent data loss — but confusing if she's mid-task and hasn't refreshed). Refreshing after this step picks up both the new app code (server-routed writes, which keep working) and has the live listener re-authorize against the new rules.
6. Manually rehearse, in this environment, with real (or fake) test data: a manual invoice, an AI invoice, a payment, a deliberate response-loss-then-retry (confirms B1's fix), and a logout/denied-access check — the same scenarios the targeted regression tests below cover in isolation, but end to end.

### Rollback — must retain restricted access, never default back to open rules

Reopening the wildcard rules as a "rollback" is not safe: it would make `storeMembers` (and every business collection)
world-writable again, exactly the exposure this whole change closes. Roll back in the OPPOSITE direction from how
you deployed, and stay restrictive throughout:
- **App code issue, rules already restrictive**: redeploy the previous (but still Task-B-or-later) app build. Do **not** roll back past this change while restrictive rules are live — pre-Task-B app code writes directly from the browser, which the restrictive rules correctly refuse, so that combination just breaks the UI, it doesn't "revert" anything.
- **Need to fully undo this change (code AND rules) for some reason**: revert the rules and the app code together, in the same maintenance window, not independently — and only to the OLD wildcard rules if you specifically intend to accept fully open access again (treat this as a deliberate, last-resort exception, not a routine rollback step, and re-close it as soon as possible).
- **Membership**: `npm run members:remove -- <email>` takes effect on that account's very next server request — no propagation delay, no token-cache wait — and (since B3) on its next direct Firestore read too, including an already-open chat transcript listener.
