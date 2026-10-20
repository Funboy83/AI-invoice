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
 *
 * An iPhone/iPad app added to the Home Screen can't print at all (window.print() does nothing there), so
 * there the page's print layout (the element marked data-print-root) is turned into a PDF and handed to the
 * share sheet, which has Print and Save to Files.
 */
export async function printPage() {
  const name = printName();
  if (isIosHomeScreenApp()) {
    const root = document.querySelector<HTMLElement>("[data-print-root]");
    if (root) return sharePrintLayoutAsPdf(root, name ?? "invoice");
  }
  // Safari and Chrome name a saved PDF after the page title, so show the print name there while printing.
  if (name) showTitleWhilePrinting(name);

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

function printName(): string | null {
  return document.querySelector<HTMLElement>("[data-print-name]")?.dataset.printName || null;
}

let savedTitle: string | null = null;

function showTitleWhilePrinting(name: string) {
  if (savedTitle === null) savedTitle = document.title;
  document.title = name;
  window.addEventListener(
    "afterprint",
    () => {
      if (savedTitle !== null) document.title = savedTitle;
      savedTitle = null;
    },
    { once: true },
  );
}

function isIosHomeScreenApp(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  return ios && (nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches);
}

// A4 portrait in mm, with the same 12mm margin as the @page rule in globals.css.
const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 12;
// Lay the copy out at roughly A4's printable width so it looks like the printed page.
const LAYOUT_WIDTH_PX = 720;

async function sharePrintLayoutAsPdf(root: HTMLElement, name: string) {
  const sheet = openSheet();
  try {
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas-pro"), import("jspdf")]);

    // The print layout is display:none on screen; render a visible copy off to the side.
    const holder = document.createElement("div");
    holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${LAYOUT_WIDTH_PX}px;background:#fff;`;
    const copy = root.cloneNode(true) as HTMLElement;
    copy.classList.remove("hidden");
    copy.style.display = "block";
    copy.style.background = "#fff";
    holder.appendChild(copy);
    document.body.appendChild(holder);
    let canvas: HTMLCanvasElement;
    try {
      canvas = await html2canvas(copy, { scale: 2, backgroundColor: "#ffffff", windowWidth: LAYOUT_WIDTH_PX });
    } finally {
      holder.remove();
    }

    const pdf = new jsPDF({ unit: "mm", format: "a4" });
    const contentW = PAGE_W - MARGIN * 2;
    const contentH = PAGE_H - MARGIN * 2;
    const pxPerMm = canvas.width / contentW;
    const sliceH = Math.floor(contentH * pxPerMm);
    for (let y = 0, page = 0; y < canvas.height; y += sliceH, page++) {
      const h = Math.min(sliceH, canvas.height - y);
      const slice = document.createElement("canvas");
      slice.width = canvas.width;
      slice.height = h;
      slice.getContext("2d")!.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
      if (page > 0) pdf.addPage();
      pdf.addImage(slice.toDataURL("image/jpeg", 0.92), "JPEG", MARGIN, MARGIN, contentW, h / pxPerMm);
    }

    const file = new File([pdf.output("blob")], `${name.replace(/[^\w.-]+/g, "_")}.pdf`, { type: "application/pdf" });
    sheet.ready(file);
  } catch (e) {
    sheet.failed(e instanceof Error ? e.message : String(e));
  }
}

/**
 * A small bottom sheet: "Preparing PDF…", then a Print / Share button. The share sheet has to be opened by a
 * fresh tap (iPhone only allows it right after one), so it can't open by itself once the PDF is ready.
 */
function openSheet() {
  const backdrop = document.createElement("div");
  backdrop.style.cssText =
    "position:fixed;inset:0;z-index:100;background:rgba(15,23,42,.4);display:flex;align-items:flex-end;justify-content:center;";
  const panel = document.createElement("div");
  panel.style.cssText =
    "width:100%;max-width:28rem;background:#fff;border-radius:1rem 1rem 0 0;padding:1.25rem 1.25rem calc(1.25rem + env(safe-area-inset-bottom));font:15px system-ui,-apple-system,sans-serif;color:#0f172a;";
  const text = document.createElement("p");
  text.textContent = "Preparing PDF…";
  text.style.cssText = "margin:0 0 1rem;text-align:center;";
  const primary = button("Print / Share PDF", "#4f46e5", "#fff");
  primary.disabled = true;
  primary.style.opacity = ".5";
  const close = button("Close", "#f1f5f9", "#334155");
  close.style.marginTop = ".5rem";
  panel.append(text, primary, close);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  const remove = () => backdrop.remove();
  close.onclick = remove;
  backdrop.onclick = (e) => e.target === backdrop && remove();

  return {
    ready(file: File) {
      text.textContent = "Tap below, then choose Print (or Save to Files).";
      primary.disabled = false;
      primary.style.opacity = "1";
      primary.onclick = async () => {
        try {
          if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file], title: file.name });
          } else {
            window.open(URL.createObjectURL(file), "_blank");
          }
          remove();
        } catch (e) {
          // Closing the share sheet without choosing anything is not an error.
          if (e instanceof DOMException && e.name === "AbortError") return;
          text.textContent = "Could not open the share sheet. Try again.";
        }
      };
    },
    failed(message: string) {
      text.textContent = `Could not make the PDF: ${message}`;
      primary.remove();
    },
  };
}

function button(label: string, bg: string, color: string) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText = `display:block;width:100%;border:0;border-radius:.75rem;padding:.8rem;font:600 15px system-ui,-apple-system,sans-serif;background:${bg};color:${color};`;
  return b;
}
