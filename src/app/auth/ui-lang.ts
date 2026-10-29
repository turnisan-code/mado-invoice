import { isUiLang, type UiLang } from '@/lib/i18n'

// Signed-out visitors cannot read settings (RLS). The language last chosen in the app is kept in
// this cookie, so the sign-in pages speak it; otherwise the browser's preferred language, then English.
export const UI_LANG_COOKIE = 'mado_ui_lang'
export const UI_LANG_COOKIE_MAX_AGE = 60 * 60 * 24 * 400

// Written in the browser on signing out (the language can also change in Settings, which sets no
// cookie), so the sign-in page keeps the app's language.
export function rememberUiLang(lang: UiLang) {
  document.cookie = `${UI_LANG_COOKIE}=${lang}; Path=/; Max-Age=${UI_LANG_COOKIE_MAX_AGE}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
}

export function anonymousUiLang(cookie: string | undefined, acceptLanguage: string | null): UiLang {
  if (isUiLang(cookie)) return cookie
  return (acceptLanguage ?? '').split(',').map(part => part.trim().slice(0, 2).toLowerCase()).find(isUiLang) ?? 'en'
}
