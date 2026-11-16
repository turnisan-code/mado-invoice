import { NextRequest, NextResponse } from 'next/server'
import { apiError, isUuid, requireUser, settingsUnavailable } from '@/lib/auth'
import { BOOKAMAT_SETTINGS_COLUMNS, type BookamatSettings } from '@/lib/bookamat'
import { expenseError } from '@/lib/expenses/api'
import { discardLinePending } from '@/lib/expenses/book'

// „Offenen Versuch verwerfen“: an attempt whose outcome is open, discarded when Bookamat has no
// booking of it (when it has one, booking the line again records that one). `?force=1`: the owner
// checked Bookamat himself (an attempt Bookamat never confirmed, two bookings Mado cannot tell
// apart).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Statement line not found')
  const { data: settings, error } = await supabase.from('settings').select(BOOKAMAT_SETTINGS_COLUMNS).single()
  if (error || !settings) return settingsUnavailable(error)
  try {
    const force = req.nextUrl.searchParams.get('force') === '1'
    return NextResponse.json(await discardLinePending(supabase, settings as unknown as BookamatSettings, id, { force }))
  } catch (err) {
    return expenseError(err)
  }
}
