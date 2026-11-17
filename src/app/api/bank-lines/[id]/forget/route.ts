import { NextRequest, NextResponse } from 'next/server'
import { apiError, isUuid, requireUser, settingsUnavailable } from '@/lib/auth'
import { BOOKAMAT_SETTINGS_COLUMNS, type BookamatSettings } from '@/lib/bookamat'
import { expenseError } from '@/lib/expenses/api'
import { forgetLineBooking } from '@/lib/expenses/book'

// „Buchung vergessen“: the line's booking was deleted in Bookamat; Mado forgets it and the line
// is open again. Bookamat is asked first.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Statement line not found')
  const { data: settings, error } = await supabase.from('settings').select(BOOKAMAT_SETTINGS_COLUMNS).single()
  if (error || !settings) return settingsUnavailable(error)
  try {
    return NextResponse.json(await forgetLineBooking(supabase, settings as unknown as BookamatSettings, id))
  } catch (err) {
    return expenseError(err)
  }
}
