import { NextRequest, NextResponse } from 'next/server'
import { apiError, invalidJson, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { expenseError } from '@/lib/expenses/api'
import { LINE_SETTINGS_COLUMNS, MAX_BOOK, parseBookEntries } from '@/lib/expenses/input'
import { bookLines, type LineSettings, type LoadReceipt } from '@/lib/expenses/book'

export const maxDuration = 60

// Books the lines the owner ticked ({ lines: [{ id, fingerprint }], dryRun? }), one by one
// (lib/expenses/book.ts): each only as the page showed it (its fingerprint). A dry run checks and
// builds each booking and books nothing. Only production posts to Bookamat.
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  const entries = parseBookEntries(body.lines)
  if (!entries) return apiError(400, 'invalid_request', `lines must be 1–${MAX_BOOK} statement lines, each { id, fingerprint }`)
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return apiError(400, 'invalid_request', 'Invalid dryRun')
  const { data: settings, error } = await supabase.from('settings').select(LINE_SETTINGS_COLUMNS).single()
  if (error || !settings) return settingsUnavailable(error)

  const loadReceipt: LoadReceipt = async line => {
    if (!line.receipt_path) return null
    const { data, error: dlErr } = await supabase.storage.from('receipts').download(line.receipt_path)
    if (dlErr || !data) return null
    return { bytes: new Uint8Array(await data.arrayBuffer()), name: line.receipt_name }
  }
  try {
    const results = await bookLines(supabase, settings as unknown as LineSettings, entries, {
      dryRun: body.dryRun === true, deadline: Date.now() + 50_000, loadReceipt,
    })
    return NextResponse.json({ results })
  } catch (err) {
    return expenseError(err)
  }
}
