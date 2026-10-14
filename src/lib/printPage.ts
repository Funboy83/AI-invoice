import { disableNetwork, enableNetwork } from "firebase/firestore";
import { db } from "./firebase";

/**
 * Print the current page, working around Safari (Mac and iPhone).
 *
 * Safari won't print while the page is still "loading" — it saves the request and prints once loading
 * finishes. Firestore's live listeners keep a request open the whole time the page is up, so in Safari
 * the Print button seemed to do nothing, and the print dialog popped up only when the tab was closed.
 * Pausing Firestore's connection for a moment closes that request, so Safari prints right away. Unsaved
 * writes are kept by Firestore and sent when the connection comes back.
 */
export async function printPage() {
  let paused = false;
  try {
    await disableNetwork(db);
    paused = true;
  } catch {
    // Printing matters more than the pause; try anyway.
  }
  try {
    window.print();
  } finally {
    // Give Safari a moment to open its print sheet before live updates reconnect.
    if (paused) setTimeout(() => void enableNetwork(db).catch(() => {}), 1000);
  }
}
