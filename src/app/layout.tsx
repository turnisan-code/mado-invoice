import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/ui/ThemeProvider";
import { LanguageProvider } from "@/lib/i18n/client";
import { getUiLang } from "@/lib/i18n/server";
import type { UiLang } from "@/lib/i18n";
import { PORTAL_TOKEN_HEADER } from "@/app/portal/html-lang";
import { sharedDocumentLanguage } from "@/app/portal/[token]/language";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const viewport: Viewport = {
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafa' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
}

export const metadata: Metadata = {
  title: "Mado Invoice",
  description: "Invoicing for Mado",
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Mado',
  },
};

// A shared document's portal page is in the document's language (the proxy passes its token on);
// every other page in the UI language, read here (not only in the app layout) so <html lang> and
// the root error/not-found pages follow it. Both lookups are cached per request.
async function pageLanguage(): Promise<UiLang> {
  const token = (await headers()).get(PORTAL_TOKEN_HEADER)
  return (token ? await sharedDocumentLanguage(token) : null) ?? getUiLang()
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await pageLanguage()
  return (
    <html lang={lang} className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full">
        <ThemeProvider>
          <LanguageProvider lang={lang}>
            {children}
          </LanguageProvider>
          <Toaster
            richColors
            position="top-right"
            mobileOffset={{ top: 'calc(env(safe-area-inset-top) + 12px)', left: 12, right: 12 }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
