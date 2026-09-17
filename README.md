# Invoice AI — Virtual Secretary

A simple, modern invoicing web app with Firestore as the database and an AI assistant ("virtual secretary") that can create invoices, manage inventory, and manage customers through chat — in addition to full manual CRUD via the UI.

## Features

- **Dashboard** — revenue, invoice count, inventory count, low-stock warnings, recent invoices.
- **Invoices** — manual creation UI + AI chat creation, editable with a required reason, full audit log (before/after) for every AI or manual edit.
- **Inventory** — manual CRUD; stock is automatically deducted when an invoice is created or edited.
- **Customers** — manual CRUD; auto-created by the AI when invoicing a new customer.
- **AI secretary** (bottom-right chat button) — can:
  - Parse natural language requests to build invoices, computing line totals and the grand total.
  - Ask you for missing quantity/price before adding a line item.
  - Search inventory before creating a new item, and **must ask for confirmation** if a similar item name already exists, instead of silently creating a duplicate.
  - Deduct stock automatically when an invoice is created.
  - Edit invoices, always writing a reasoned entry to the audit log.

## Setup

1. **Install dependencies** (already done if you're reading this after scaffolding):
   ```bash
   npm install
   ```
2. **Create a Firebase project** at https://console.firebase.google.com, enable **Firestore Database** (start in test mode for local development), then add a Web App and copy its config values.
3. **Copy the env template** and fill in your Firebase + OpenAI values:
   ```bash
   cp .env.local.example .env.local
   ```
   - `NEXT_PUBLIC_FIREBASE_*` — from Firebase Console > Project settings > General > Your apps.
   - `OPENAI_API_KEY` — required for the AI chat assistant (`/api/chat`). Without it, the rest of the app (manual CRUD) still works, but chat will show a configuration error.
4. **Run the dev server**:
   ```bash
   npm run dev
   ```
   Open http://localhost:3000.

### Firestore security rules

This prototype uses the Firestore client SDK directly (including from the AI's API route) for simplicity. Before going beyond local testing, lock down rules, e.g.:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null; // add real auth + rules per collection
    }
  }
}
```

## Data model (Firestore collections)

- `items` — inventory: name, sku, price, quantity, unit.
- `customers` — name, email, phone, address.
- `invoices` — number, customerId/customerName, lineItems[], subtotal/tax/total, status, createdBy.
- `invoiceLogs` — invoiceId, actor (`ai`/`user`), action, message, before/after snapshots.
- `counters` — sequential invoice numbering.

## Project structure

- `src/lib/firebase.ts` — Firebase client init.
- `src/lib/store.ts` — Firestore reads/writes, including transactional invoice create/update with stock reconciliation and logging.
- `src/lib/ai/tools.ts` — tool definitions + executor used by the AI assistant.
- `src/app/api/chat/route.ts` — agentic loop calling OpenAI with tool calling.
- `src/components/ChatPanel.tsx` — the chat UI (bottom-right "Ask AI" drawer).
- `src/app/*` — Dashboard, Invoices, Inventory, Customers pages.
