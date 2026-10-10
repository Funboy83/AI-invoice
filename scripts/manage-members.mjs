#!/usr/bin/env node
// Administrator-only CLI for src/lib/server/membership.ts — the ONE place store access is granted or revoked.
// Never printed, ever: the service-account key, or anything from it. This script never runs inside the app, is
// never reachable over HTTP, and there is no self-service way to grant access — only whoever runs this script,
// locally, holding FIREBASE_SERVICE_ACCOUNT_JSON, can add or remove a member.
//
// Usage:
//   node scripts/manage-members.mjs list
//   node scripts/manage-members.mjs add <email> [--by=<admin-email>] [--store-id=main]
//   node scripts/manage-members.mjs remove <email> [--store-id=main]
//
// Requires the Firebase Auth account for <email> to ALREADY exist (create it in Firebase Console >
// Authentication > Users, or have the person sign up once) — this script only manages store MEMBERSHIP, never
// Auth accounts or passwords.

import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function loadEnvLocal() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* fine if it doesn't exist — env vars may already be set another way */
  }
}

function credentialsFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) {
    console.error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not set. Add it to .env.local (see .env.local.example) — the same\n" +
        "service-account key the server uses. This script never prints it."
    );
    process.exit(1);
  }
  const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const json = JSON.parse(text);
  return { projectId: json.project_id, clientEmail: json.client_email, privateKey: String(json.private_key ?? "").replace(/\\n/g, "\n") };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = {};
  for (const arg of rest) {
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (m) flags[m[1]] = m[2];
    else positional.push(arg);
  }
  return { command, positional, flags };
}

async function main() {
  loadEnvLocal();
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const storeId = flags["store-id"]?.trim() || process.env.APP_STORE_ID?.trim() || "main";

  const creds = credentialsFromEnv();
  const app = initializeApp({ credential: cert(creds) }, "manage-members");
  const auth = getAuth(app);
  const db = getFirestore(app);
  const members = db.collection("storeMembers");

  if (command === "list") {
    const snap = await members.get();
    if (snap.empty) {
      console.log(`No members yet for store "${storeId}".`);
      return;
    }
    console.log(`Members of store "${storeId}":`);
    for (const doc of snap.docs) {
      const d = doc.data();
      if (d.storeId !== storeId) continue;
      console.log(`  ${d.email}  (uid ${doc.id}, added ${new Date(d.addedAt).toISOString()}${d.addedByEmail ? ` by ${d.addedByEmail}` : ""})`);
    }
    return;
  }

  const email = positional[0]?.trim().toLowerCase();
  if (!email || (command !== "add" && command !== "remove")) {
    console.error(__doc());
    process.exit(1);
  }

  const user = await auth.getUserByEmail(email).catch(() => null);
  if (!user) {
    console.error(`No Firebase Auth account exists for ${email}. Create it first (Firebase Console > Authentication > Users, or have them sign up), then run this again.`);
    process.exit(1);
  }

  if (command === "add") {
    const addedByEmail = flags.by?.trim() || "local-script";
    await members.doc(user.uid).set({ uid: user.uid, email, storeId, addedAt: Date.now(), addedByEmail });
    console.log(`Added ${email} (uid ${user.uid}) to store "${storeId}". Effective immediately — no restart needed.`);
  } else {
    const existing = await members.doc(user.uid).get();
    if (!existing.exists) {
      console.log(`${email} (uid ${user.uid}) is not a member of store "${storeId}" — nothing to remove.`);
      return;
    }
    await members.doc(user.uid).delete();
    console.log(
      `Removed ${email} (uid ${user.uid}) from store "${storeId}". Effective on their NEXT server request — a page\n` +
        "already open in their browser keeps showing what it already loaded until they navigate, reload, or send a\n" +
        "message; any AI job already running for them stops before its next step or tool call, without repeating\n" +
        "anything it already completed."
    );
  }
}

function __doc() {
  return [
    "Usage:",
    "  node scripts/manage-members.mjs list",
    "  node scripts/manage-members.mjs add <email> [--by=<admin-email>] [--store-id=main]",
    "  node scripts/manage-members.mjs remove <email> [--store-id=main]",
  ].join("\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
