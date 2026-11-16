import { NextRequest, NextResponse } from 'next/server'
import { apiError, requireUser, settingsUnavailable } from '@/lib/auth'
import { BOOKAMAT_SETTINGS_COLUMNS, credentialsOf, type BookamatSettings } from '@/lib/bookamat'
import { readExpenseAccounts } from '@/lib/expenses/accounts'
import { expenseError } from '@/lib/expenses/api'
import { today } from '@/lib/utils/document'

// A year's Bookamat accounts with their details (?year=, default this year): the Buchungsregel
// editor's choices and the row editor's
export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const raw = req.nextUrl.searchParams.get('year')
  const year = raw ? Number(raw) : Number(today().slice(0, 4))
  if (!Number.isInteger(year) || year < 2000 || year > 2999) return apiError(400, 'invalid_request', 'Invalid year')
  const { data: settings, error } = await auth.supabase.from('settings').select(BOOKAMAT_SETTINGS_COLUMNS).single()
  if (error || !settings) return settingsUnavailable(error)
  try {
    return NextResponse.json(await readExpenseAccounts(credentialsOf(settings as unknown as BookamatSettings), year))
  } catch (err) {
    return expenseError(err)
  }
}
