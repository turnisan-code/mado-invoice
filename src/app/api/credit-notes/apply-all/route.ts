import { NextResponse } from 'next/server'
import { apiError, requireUser } from '@/lib/auth'
import { applyCreditNote, unappliedCreditNotes } from '@/lib/credits'

export const maxDuration = 60

// Catches up on issued credit notes that never reduced their invoice's balance (issued before
// credits were recorded, or the automatic apply failed). Each credit is dated on its credit note,
// when it took effect. Returns how many were applied and the numbers of those that failed.
export async function POST() {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  let pending
  try {
    pending = await unappliedCreditNotes(supabase)
  } catch (err) {
    console.error('[credit-notes/apply-all]', err)
    return apiError(500, 'database', err instanceof Error ? err.message : String(err))
  }

  let applied = 0
  const failed: string[] = []
  for (const cn of pending) {
    try {
      const result = await applyCreditNote(supabase, cn.id, { date: cn.date })
      if (result.applied) applied++
    } catch (err) {
      console.error(`[credit-notes/apply-all] ${cn.number}:`, err)
      failed.push(cn.number)
    }
  }
  return NextResponse.json({ applied, failed })
}
