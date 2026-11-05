import { NextResponse, type NextRequest } from 'next/server'
import { CONSENT_PATH, appUrl } from '@/lib/mcp/config'
import { parseAuthorizeRequest, signAuthRequest } from '@/lib/mcp/oauth/request'
import { anonymousUiLang, UI_LANG_COOKIE } from '@/app/auth/ui-lang'
import { makeT } from '@/lib/i18n'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

// Nothing is stored here: the validated request travels signed to the consent page, which the
// proxy only shows after sign-in and the second factor.
export async function GET(req: NextRequest) {
  const result = await parseAuthorizeRequest(req.nextUrl.searchParams)
  if (result.ok) {
    const consent = new URL(appUrl(CONSENT_PATH))
    consent.searchParams.set('r', signAuthRequest(result.request))
    return NextResponse.redirect(consent, { status: 303, headers: NO_STORE })
  }
  if ('redirectTo' in result) return NextResponse.redirect(result.redirectTo, { status: 303, headers: NO_STORE })

  // An unknown client or a redirect we cannot trust: never send the browser there.
  const lang = anonymousUiLang(req.cookies.get(UI_LANG_COOKIE)?.value, req.headers.get('accept-language'))
  const t = makeT(lang)
  const message = t(result.page === 'client' ? 'mcp.consent.unknownClient' : 'mcp.consent.badRedirect')
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(t('mcp.consent.title'))}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${escapeHtml(t('mcp.consent.requestRefused'))}</h1><p>${escapeHtml(message)}</p></body></html>`
  return new Response(html, { status: 400, headers: { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8' } })
}
