import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { anonymousUiLang, UI_LANG_COOKIE } from '@/app/auth/ui-lang'
import { isUiLang, makeT, type TFn, type UiLang } from './index'

// One settings read per request, shared by the root layout (<html lang>), the app layout and every
// page. Signed out, settings are unreadable (RLS): the language last used in the app, kept in a
// cookie, else the browser's preferred one.
export const getUiLang = cache(async (): Promise<UiLang> => {
  const supabase = await createClient()
  const { data } = await supabase.from('settings').select('ui_language').maybeSingle()
  if (isUiLang(data?.ui_language)) return data.ui_language
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()])
  return anonymousUiLang(cookieStore.get(UI_LANG_COOKIE)?.value, headerList.get('accept-language'))
})

export async function getT(): Promise<{ t: TFn; lang: UiLang }> {
  const lang = await getUiLang()
  return { t: makeT(lang), lang }
}
