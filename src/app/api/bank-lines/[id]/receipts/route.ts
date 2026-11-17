import { NextRequest, NextResponse } from 'next/server'
import { apiError, invalidJson, isUuid, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { expenseError } from '@/lib/expenses/api'
import { searchLineReceipt } from '@/lib/expenses/receipts'
import { gmailReadRefusal, recordGmailError, RECEIPT_SETTINGS_COLUMNS, searchDeps, type ReceiptSettings } from '@/lib/expenses/receipt-deps'

// One line's search in its own request (lib/expenses/receipts.ts SEARCH_MAX_DURATION_S)
export const maxDuration = 60

// „In Gmail suchen“ for one statement line (PR 9b): Gmail is read for its receipt, the PDFs found
// are read by Claude, a receipt proven is attached (a copy in the 'receipts' bucket) and what was
// found is kept on the line. `auto`: the page's search after an upload, only from the switch-over
// date on (decision D11). `dryRun`: „Probelauf“, searched and read as a search is, nothing kept.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now()
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Statement line not found')
  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  for (const key of ['dryRun', 'auto'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') return apiError(400, 'invalid_request', `Invalid ${key}`)
  }
  const { data: settings, error } = await supabase.from('settings').select(RECEIPT_SETTINGS_COLUMNS).single()
  if (error || !settings) return settingsUnavailable(error)
  const s = settings as unknown as ReceiptSettings
  const refusal = gmailReadRefusal(s)
  if (refusal) return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: refusal.status })

  try {
    const result = await searchLineReceipt(supabase, id, searchDeps(s, supabase), {
      dryRun: body.dryRun === true, auto: body.auto === true, expensesFrom: s.expenses_from ?? null, startedAt,
    })
    if (result.status === 'searched' && result.gmailError) await recordGmailError(result.gmailError, supabase, s.id)
    if (result.status === 'searched') {
      const { gmailError: _gmail, ...answer } = result
      void _gmail
      return NextResponse.json(answer)
    }
    return NextResponse.json(result)
  } catch (err) {
    return expenseError(err)
  }
}
