import { initializeApp, getApps, getApp, type FirebaseOptions } from "firebase/app";
import { getFirestore, initializeFirestore, memoryLocalCache, memoryLruGarbageCollector, type Firestore } from "firebase/firestore";
import { getAuth, type Auth } from "firebase/auth";

const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Reuse the app instance across hot reloads and server/client calls.
export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = createDb();

/**
 * Keep documents already downloaded IN MEMORY while the app is open (LRU cache), instead of the default that drops
 * them the moment a page's listener detaches. Every page live-listens to the full invoices/customers/products
 * lists, so without this each page switch re-downloaded all of them. With it, a page re-opens from memory at once
 * and the listener then syncs only what changed with the server; live updates (payments, edits) arrive exactly
 * as before. Memory only: nothing is written to the device, and it is gone when the tab closes. Sign-out and
 * account switches reload the page (useAppAuth.tsx), so one account's cached data never shows to another.
 */
function createDb(): Firestore {
  try {
    return initializeFirestore(firebaseApp, { localCache: memoryLocalCache({ garbageCollector: memoryLruGarbageCollector() }) });
  } catch {
    // Already initialized (hot reload re-running this module) — reuse that instance.
    return getFirestore(firebaseApp);
  }
}

/** Firebase Auth (browser only) — identifies who is using the AI chat. Call from client components/effects. */
export function getClientAuth(): Auth {
  return getAuth(firebaseApp);
}
