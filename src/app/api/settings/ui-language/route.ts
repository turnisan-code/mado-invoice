import { NextRequest, NextResponse } from 'next/server'
import { apiError, databaseError, invalidJson, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { isUiLang } from '@/lib/i18n'
import { UI_LANG_COOKIE, UI_LANG_COOKIE_MAX_AGE } from '@/app/auth/ui-lang'

export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  const lang = body.lang
  if (!isUiLang(lang)) return apiError(400, 'invalid_request', 'Invalid language')

  const { data: settings, error: settingsErr } = await supabase.from('settings').select('id').single()
  if (settingsErr || !settings) return settingsUnavailable(settingsErr)

  const { error } = await supabase.from('settings').update({ ui_language: lang }).eq('id', settings.id)
  if (error) return databaseError(error)
  const res = NextResponse.json({ lang })
  // Read by the sign-in pages once signed out.
  res.cookies.set(UI_LANG_COOKIE, lang, { path: '/', sameSite: 'lax', maxAge: UI_LANG_COOKIE_MAX_AGE, secure: process.env.NODE_ENV === 'production' })
  return res
}
