import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";

/** Thrown when required server configuration is missing; surfaced to the client as a 503 with a fix-it hint. */
export class ConfigError extends Error {}

let testDb: Firestore | null = null;
/** Tests inject an in-memory Firestore here. Never called in production code. */
export function __setAdminDbForTests(db: Firestore | null) {
  testDb = db;
}

function credentialsFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  // Accept raw JSON or base64-encoded JSON (multi-line values are awkward in some env UIs).
  const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  try {
    const json = JSON.parse(text);
    return { ...json, privateKey: String(json.private_key ?? "").replace(/\\n/g, "\n") };
  } catch {
    throw new ConfigError("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON (or base64-encoded JSON).");
  }
}

function getAdminApp(): App {
  const existing = getApps().find((a) => a.name === "chat-admin");
  if (existing) return existing;

  // The Firestore emulator needs no credentials — only a project id.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "demo-local" }, "chat-admin");
  }
  const creds = credentialsFromEnv();
  if (!creds) {
    throw new ConfigError(
      "Durable chat needs FIREBASE_SERVICE_ACCOUNT_JSON (a Firebase service-account key). " +
        (process.env.VERCEL
          ? "Add it in Vercel → Settings → Environment Variables, then redeploy."
          : "Add it to .env.local and restart the dev server.")
    );
  }
  return initializeApp(
    { credential: cert({ projectId: creds.project_id, clientEmail: creds.client_email, privateKey: creds.privateKey }) },
    "chat-admin"
  );
}

let settingsApplied = false;
export function getAdminDb(): Firestore {
  if (testDb) return testDb;
  const db = getFirestore(getAdminApp());
  if (!settingsApplied) {
    db.settings({ ignoreUndefinedProperties: true });
    settingsApplied = true;
  }
  return db;
}

export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}
