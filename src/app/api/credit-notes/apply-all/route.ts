import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyCreditNote, unappliedCreditNotes } from '@/lib/credits'

export const maxDuration = 60

// Catches up on issued credit notes that never reduced their invoice's balance (issued before
// credits were recorded, or the automatic apply failed). Each credit is dated on its credit note,
// when it took effect. Returns how many were applied and which failed.
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let pending
  try {
    pending = await unappliedCreditNotes(supabase)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }

  let applied = 0
  const failed: string[] = []
  for (const cn of pending) {
    try {
      const result = await applyCreditNote(supabase, cn.id, { date: cn.date })
      if (result.applied) applied++
    } catch (err) {
      failed.push(`${cn.number} (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  return NextResponse.json({ applied, failed })
}
