import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyCreditNote } from '@/lib/credits'
import { getT } from '@/lib/i18n/server'

// Applies an issued credit note to its invoice by hand: for one issued before credits were
// recorded, after the automatic apply failed, or once the invoice is open again.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { t } = await getT()

  try {
    const result = await applyCreditNote(supabase, id)
    if (!result.applied) return NextResponse.json({ error: t('lifecycle.credit.nothingToApply') }, { status: 409 })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: t('lifecycle.credit.applyFailed', { error: err instanceof Error ? err.message : String(err) }) }, { status: 500 })
  }
}
