import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/ui/ThemeProvider";
import { LanguageProvider } from "@/lib/i18n/client";
import { getUiLang } from "@/lib/i18n/server";

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

// The UI language is read here (not only in the app layout) so <html lang> and the root
// error/not-found pages follow it; the lookup is cached per request.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await getUiLang()
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
