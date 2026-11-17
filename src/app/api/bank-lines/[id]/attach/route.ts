import { NextRequest, NextResponse } from 'next/server'
import { apiError, isUuid, requireUser, settingsUnavailable } from '@/lib/auth'
import { BOOKAMAT_SETTINGS_COLUMNS, type BookamatSettings } from '@/lib/bookamat'
import { expenseError } from '@/lib/expenses/api'
import { attachLineReceipt, type LoadReceipt } from '@/lib/expenses/book'

export const maxDuration = 60

// „Beleg anhängen“: the Beleg of a booked line that was not attached when it was booked
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Statement line not found')
  const { data: settings, error } = await supabase.from('settings').select(BOOKAMAT_SETTINGS_COLUMNS).single()
  if (error || !settings) return settingsUnavailable(error)
  const loadReceipt: LoadReceipt = async line => {
    if (!line.receipt_path) return null
    const { data, error: dlErr } = await supabase.storage.from('receipts').download(line.receipt_path)
    if (dlErr || !data) return null
    return { bytes: new Uint8Array(await data.arrayBuffer()), name: line.receipt_name }
  }
  try {
    return NextResponse.json(await attachLineReceipt(supabase, settings as unknown as BookamatSettings, id, loadReceipt))
  } catch (err) {
    return expenseError(err)
  }
}
