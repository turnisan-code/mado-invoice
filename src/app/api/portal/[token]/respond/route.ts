import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/events'
import { formatDate, today } from '@/lib/utils/document'
import { clientDisplayName } from '@/lib/utils/clients'
import { isExpired } from '@/lib/status'
import { sendReminderEmail } from '@/lib/utils/reminder'
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
      await sendReminderEmail({
        auth: getAuthorizedGoogle(settings, supabase),
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

  let body: { action?: unknown } | null
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const action = body?.action
  if (action !== 'accepted' && action !== 'rejected') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: doc } = await supabase
    .from('documents')
    .select('id, type, status, number, due_date, language, clients(name, company)')
    .eq('share_token', token)
    .single()

  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (doc.type !== 'quote') return NextResponse.json({ error: 'Not a quote' }, { status: 400 })

  // The client's page is in the quote's language.
  const docLang = doc.language === 'en' ? 'en' : 'de'
  if (isExpired(doc, today())) {
    return NextResponse.json({ error: makeT(docLang)('lifecycle.portal.expiredNotice', { date: formatDate(doc.due_date!, docLang) }), code: 'expired' }, { status: 409 })
  }

  // Conditional on 'sent', so a second answer (or one after the owner decided) changes nothing.
  const { data: updated, error } = await supabase
    .from('documents')
    .update({ status: action, responded_at: new Date().toISOString() })
    .eq('id', doc.id)
    .eq('status', 'sent')
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!updated?.length) return NextResponse.json({ error: 'Quote is not in sent status', code: 'answered' }, { status: 409 })

  await logEvent(supabase, doc.id, 'portal_responded', { action })
  await notifyOwner(supabase, doc as unknown as QuoteRow, action, req.nextUrl.origin)

  return NextResponse.json({ ok: true, status: action })
}
