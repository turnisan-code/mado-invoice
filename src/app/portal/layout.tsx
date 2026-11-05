import type { Metadata, Viewport } from 'next'

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

// The client sees the document as printed, so the portal is light whatever the device prefers:
// ThemeProvider forces the light theme on /portal (no `dark` class), and the browser chrome and
// form controls follow from these.
export const viewport: Viewport = {
  themeColor: '#f5f5f5',
  colorScheme: 'light',
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-neutral-100 text-neutral-900 [color-scheme:light]">{children}</div>
}
