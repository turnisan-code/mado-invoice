import type { Metadata } from 'next'

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

// The portal is always light: ThemeProvider forces the theme on /portal, so this only sets the canvas.
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-neutral-100 text-neutral-900">{children}</div>
}
