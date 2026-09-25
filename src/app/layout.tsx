import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import ChatPanel from "@/components/ChatPanel";
import BottomNav from "@/components/BottomNav";
import RequireAuth from "@/components/RequireAuth";
import { AppAuthProvider } from "@/lib/useAppAuth";
import { AiChatProvider } from "@/lib/useAiChat";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Invoice AI — Virtual Secretary",
  description: "Simple invoicing app with a Vietnamese-speaking AI secretary for invoices, products, and customers.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Invoice AI",
  },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
  },
  icons: {
    icon: [
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#4f46e5",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full h-full flex bg-slate-50 text-slate-900 overscroll-none">
        <AppAuthProvider>
          <Sidebar />
          {/*
            Business pages AND the chat UI mount only once RequireAuth confirms store membership — gating both
            behind the same check, since an approved account gets both, and a denied one gets neither. AiChatProvider
            lives INSIDE the gate so logout/account-switch/revocation unmount it too, clearing its state and
            detaching its Firestore listener automatically (see RequireAuth.tsx).
          */}
          <RequireAuth>
            <AiChatProvider>
              <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
              <ChatPanel />
            </AiChatProvider>
          </RequireAuth>
          <BottomNav />
        </AppAuthProvider>
      </body>
    </html>
  );
}

