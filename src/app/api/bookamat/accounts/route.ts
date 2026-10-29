import { NextRequest, NextResponse } from 'next/server'
import { apiError, invalidJson, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { BookamatError, fetchBookamatAccounts } from '@/lib/bookamat'
import { today } from '@/lib/utils/document'

// Lists the current year's Bookamat accounts for the Settings pickers. The year goes back with
// them: Settings stores it, because Bookamat account ids differ per fiscal year.
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  const { username, country } = body
  if (typeof username !== 'string' || !username.trim() || typeof country !== 'string' || !/^[a-z]{2}$/.test(country)) {
    return apiError(400, 'invalid_request', 'username and a two-letter country are required')
  }
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
    return apiError(400, 'invalid_request', 'Invalid apiKey')
  }

  let apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!apiKey) {
    const { data: settings, error } = await supabase.from('settings').select('bookamat_api_key').single()
    if (error) return settingsUnavailable(error)
    apiKey = settings?.bookamat_api_key ?? ''
  }
  if (!apiKey) return NextResponse.json({ error: 'apiKey is required', code: 'not_configured' }, { status: 400 })

  const year = Number(today().slice(0, 4))
  try {
    const accounts = await fetchBookamatAccounts({ username: username.trim(), apiKey, country }, year)
    return NextResponse.json({ ...accounts, year })
  } catch (err) {
    const e = err instanceof BookamatError ? err : null
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Bookamat request failed', code: e?.code, detail: e?.detail }, { status: 400 })
  }
}
