'use client'

import { usePathname } from 'next/navigation'
import { ThemeProvider as NextThemesProvider } from 'next-themes'

// The client portal is always light. Tailwind's dark variant follows the class on <html>, which
// the portal layout's light wrapper cannot undo, so the theme is forced here instead.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      forcedTheme={pathname?.startsWith('/portal') ? 'light' : undefined}
    >
      {children}
    </NextThemesProvider>
  )
}
