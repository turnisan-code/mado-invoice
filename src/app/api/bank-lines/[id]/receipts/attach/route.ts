import { NextRequest, NextResponse } from 'next/server'
import { apiError, invalidJson, isUuid, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { expenseError } from '@/lib/expenses/api'
import { attachGmailCandidate } from '@/lib/expenses/receipts'
import { attachDeps, ATTACH_DEADLINE_MS, gmailReadRefusal, receiptAccountGate, recordGmailError, RECEIPT_SETTINGS_COLUMNS, type ReceiptSettings } from '@/lib/expenses/receipt-deps'
import { isGmailAuthError } from '@/lib/expenses/gmail-parts'

export const maxDuration = 60

// „Anhängen“ (PR 9b): a PDF the line's Gmail search found and did not attach becomes its receipt —
// fetched from Gmail again, read by Claude, copied into the 'receipts' bucket, proven by the owner.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Statement line not found')
  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  const messageId = body.message_id
  // An e-mail that is only a PDF names its part ''
  const partId = body.part_id ?? null
  if (typeof messageId !== 'string' || !/^[\w-]{1,100}$/.test(messageId) || (partId !== null && (typeof partId !== 'string' || !/^[\w.-]{0,40}$/.test(partId)))) {
    return apiError(400, 'invalid_request', 'message_id and part_id must name a Gmail part')
  }
  const { data: settings, error } = await supabase.from('settings').select(RECEIPT_SETTINGS_COLUMNS).single()
  if (error || !settings) return settingsUnavailable(error)
  const s = settings as unknown as ReceiptSettings
  const refusal = gmailReadRefusal(s)
  if (refusal) return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: refusal.status })

  try {
    const signal = AbortSignal.timeout(ATTACH_DEADLINE_MS)
    return NextResponse.json(await attachGmailCandidate(supabase, id, messageId, partId as string | null, attachDeps(s, supabase, signal), { accountGate: receiptAccountGate(s) }))
  } catch (err) {
    if (isGmailAuthError(err)) await recordGmailError(err, supabase, s.id)
    return expenseError(err)
  }
}
