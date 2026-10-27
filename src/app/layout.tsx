import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/ui/ThemeProvider";

const geist = Geist({ subsets: ["latin"] });

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" className="h-full antialiased" suppressHydrationWarning>
      <body className={`${geist.className} min-h-full`}>
        <ThemeProvider>
          {children}
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
