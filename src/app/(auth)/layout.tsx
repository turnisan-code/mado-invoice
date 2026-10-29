import type { Metadata } from 'next'
import { cookies, headers } from 'next/headers'
import Logo from '@/components/ui/Logo'
import { createClient } from '@/lib/supabase/server'
import { LanguageProvider } from '@/lib/i18n/client'
import { isUiLang, type UiLang } from '@/lib/i18n'
import { anonymousUiLang, UI_LANG_COOKIE } from '@/app/auth/ui-lang'

export const metadata: Metadata = { robots: { index: false, follow: false } }

// Signed in (code step, new password): the app's language. Signed out, settings are unreadable
// (RLS): the language last used in the app, else the browser's preferred one.
async function authLanguage(): Promise<UiLang> {
  const supabase = await createClient()
  const { data } = await supabase.from('settings').select('ui_language').maybeSingle()
  if (isUiLang(data?.ui_language)) return data.ui_language
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()])
  return anonymousUiLang(cookieStore.get(UI_LANG_COOKIE)?.value, headerList.get('accept-language'))
}

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const lang = await authLanguage()
  return (
    <LanguageProvider lang={lang}>
      <main lang={lang} className="min-h-dvh flex items-center justify-center px-4 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] bg-neutral-50 dark:bg-neutral-950">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex justify-center">
            <Logo />
          </div>
          {children}
        </div>
      </main>
    </LanguageProvider>
  )
}
