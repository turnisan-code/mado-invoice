import type { Metadata } from 'next'
import Logo from '@/components/ui/Logo'
import { LanguageProvider } from '@/lib/i18n/client'
import { getUiLang } from '@/lib/i18n/server'

export const metadata: Metadata = { robots: { index: false, follow: false } }

export default async function OAuthLayout({ children }: { children: React.ReactNode }) {
  const lang = await getUiLang()
  return (
    <LanguageProvider lang={lang}>
      <main lang={lang} className="min-h-dvh flex items-center justify-center px-4 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] bg-neutral-50 dark:bg-neutral-950">
        <div className="w-full max-w-md space-y-6">
          <div className="flex justify-center">
            <Logo />
          </div>
          {children}
        </div>
      </main>
    </LanguageProvider>
  )
}
