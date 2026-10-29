import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { apiError, databaseError, invalidJson, isUuid, readJsonObject } from '@/lib/auth'
import { logEvent } from '@/lib/events'
import { formatDate, today } from '@/lib/utils/document'
import { clientDisplayName } from '@/lib/utils/clients'
import { isExpired } from '@/lib/status'
import { sendGmail } from '@/lib/utils/reminder'
import { isShareExpired } from '@/lib/share'
import { clearGoogleTokens, getAuthorizedGoogle, isGoogleAuthError } from '@/lib/google/client'
import { isUiLang, makeT } from '@/lib/i18n'

type Action = 'accepted' | 'rejected'
type QuoteRow = { id: string; number: string | null; clients: { name: string; company: string | null } | null }

// Tells the owner by email (when Gmail is connected) that a client answered; the dashboard shows
// the unread 'portal_responded' event either way. Never fails the client's answer.
async function notifyOwner(supabase: SupabaseClient, quote: QuoteRow, action: Action, origin: string) {
  try {
    const { data: settings } = await supabase
      .from('settings')
      .select('id, email, gmail_email, gmail_access_token, gmail_refresh_token, gmail_token_expiry, ui_language')
      .single()
    if (!settings?.gmail_refresh_token || !settings.gmail_email) return
    // A note to the owner, so it is written in the app's language, not the quote's.
    const lang = isUiLang(settings.ui_language) ? settings.ui_language : 'en'
    const t = makeT(lang)
    const vars = { client: clientDisplayName(quote.clients) || '—', number: quote.number ?? '', date: formatDate(today(), lang) }
    const accepted = action === 'accepted'
    try {
      await sendGmail(getAuthorizedGoogle(settings, supabase), {
        from: settings.gmail_email,
        to: settings.email || settings.gmail_email,
        subject: t(accepted ? 'lifecycle.responses.emailSubjectAccepted' : 'lifecycle.responses.emailSubjectRejected', vars),
        body: `${t(accepted ? 'lifecycle.responses.emailBodyAccepted' : 'lifecycle.responses.emailBodyRejected', vars)}\n\n${t('lifecycle.responses.emailLink', { link: `${origin}/quotes/${quote.id}` })}`,
      })
    } catch (err) {
      if (isGoogleAuthError(err)) await clearGoogleTokens(supabase, settings.id)
      console.error('[portal/respond] owner notification not sent:', err instanceof Error ? err.message : err)
    }
  } catch (err) {
    console.error('[portal/respond] owner notification failed:', err)
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  // share_token is a uuid column: anything else would fail the query instead of finding nothing.
  if (!isUuid(token)) return apiError(404, 'not_found', 'Not found')

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  const action = body.action
  if (action !== 'accepted' && action !== 'rejected') return apiError(400, 'invalid_request', 'Invalid action')

  const supabase = createServiceClient()

  const { data: doc, error: lookupErr } = await supabase
    .from('documents')
    .select('id, type, status, number, due_date, language, share_expires_at, clients(name, company)')
    .eq('share_token', token)
    .maybeSingle()

  if (lookupErr) return databaseError(lookupErr)
  if (!doc?.number) return apiError(404, 'not_found', 'Not found')
  // An expired share link no longer opens the portal, so it cannot answer the quote either.
  if (isShareExpired(doc.share_expires_at)) return apiError(410, 'link_expired', 'Link expired')
  if (doc.type !== 'quote') return apiError(400, 'invalid_request', 'Not a quote')

  // The client's page is in the quote's language; 'expired' and 'answered' are final answers the
  // page shows as they are, so they are worded here in that language.
  const docLang = doc.language === 'en' ? 'en' : 'de'
  const docT = makeT(docLang)
  if (isExpired(doc, today())) {
    const message = `${docT('lifecycle.portal.expiredNotice', { date: formatDate(doc.due_date!, docLang) })} ${docT('lifecycle.portal.expiredHint')}`
    return apiError(409, 'expired', message)
  }

  // Conditional on 'sent', so a second answer (or one after the owner decided) changes nothing.
  const { data: updated, error } = await supabase
    .from('documents')
    .update({ status: action, responded_at: new Date().toISOString() })
    .eq('id', doc.id)
    .eq('status', 'sent')
    .select('id')

  if (error) return databaseError(error)
  if (!updated?.length) return apiError(409, 'answered', docT('lifecycle.portal.answered'))

  await logEvent(supabase, doc.id, 'portal_responded', { action })
  await notifyOwner(supabase, doc as unknown as QuoteRow, action, req.nextUrl.origin)

  return NextResponse.json({ ok: true, status: action })
}
