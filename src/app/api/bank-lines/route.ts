import { NextRequest, NextResponse } from 'next/server'
import { apiError, invalidJson, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { expenseError } from '@/lib/expenses/api'
import { LINE_SETTINGS_COLUMNS, parseLineInputs } from '@/lib/expenses/input'
import { analyseStored, openLines, storeLines } from '@/lib/expenses/statement'
import type { LineSettings } from '@/lib/expenses/book'

export const maxDuration = 60

// The lines still open, analysed: the „Kontoauszug“ page without a file
export async function GET() {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { data: settings, error } = await supabase.from('settings').select(LINE_SETTINGS_COLUMNS).single()
  if (error || !settings) return settingsUnavailable(error)
  try {
    const lines = await openLines(supabase)
    return NextResponse.json(await analyseStored(supabase, settings as unknown as LineSettings, lines, { deadline: Date.now() + 45_000 }))
  } catch (err) {
    return expenseError(err)
  }
}

// A statement's lines, as the page read them from the file ({ lines: [{ key, cells }] }): stored
// once each (what the owner set on a line already stored stays), then analysed. Nothing is booked.
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  const inputs = parseLineInputs(body.lines)
  if (!inputs) return apiError(400, 'invalid_request', 'lines must be 1–3000 statement lines, each { key, cells }')
  const { data: settings, error } = await supabase.from('settings').select(LINE_SETTINGS_COLUMNS).single()
  if (error || !settings) return settingsUnavailable(error)
  try {
    const { lines, unreadable } = await storeLines(supabase, inputs)
    return NextResponse.json(await analyseStored(supabase, settings as unknown as LineSettings, lines, { deadline: Date.now() + 45_000, unreadable }))
  } catch (err) {
    return expenseError(err)
  }
}
