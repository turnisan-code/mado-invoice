import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { isUiLang, makeT, type TFn, type UiLang } from './index'

// One settings read per request, shared by the root layout (<html lang>), the app layout and every page.
export const getUiLang = cache(async (): Promise<UiLang> => {
  const supabase = await createClient()
  const { data } = await supabase.from('settings').select('ui_language').single()
  return isUiLang(data?.ui_language) ? data.ui_language : 'en'
})

export async function getT(): Promise<{ t: TFn; lang: UiLang }> {
  const lang = await getUiLang()
  return { t: makeT(lang), lang }
}
