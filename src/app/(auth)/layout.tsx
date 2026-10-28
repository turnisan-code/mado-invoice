import { headers } from 'next/headers'
import Logo from '@/components/ui/Logo'
import { createClient } from '@/lib/supabase/server'
import { LanguageProvider } from '@/lib/i18n/client'
import { isUiLang, type UiLang } from '@/lib/i18n'

// Signed-out visitors cannot read settings (RLS), so the browser's preferred language picks DE or EN.
async function authLanguage(): Promise<UiLang> {
  const supabase = await createClient()
  const { data } = await supabase.from('settings').select('ui_language').maybeSingle()
  if (isUiLang(data?.ui_language)) return data.ui_language
  const accepted = (await headers()).get('accept-language') ?? ''
  return accepted.split(',').map(part => part.trim().slice(0, 2).toLowerCase()).find(isUiLang) ?? 'en'
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
