import { NextResponse } from 'next/server'
import { apiError, isUuid, requireUser } from '@/lib/auth'
import { applyCreditNote } from '@/lib/credits'

// Applies an issued credit note to its invoice by hand: for one issued before credits were
// recorded, after the automatic apply failed, or once the invoice is open again.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  if (!isUuid(id)) return apiError(404, 'not_found', 'Not found')

  try {
    const result = await applyCreditNote(auth.supabase, id)
    if (!result.applied) return apiError(409, 'nothing_to_apply', 'Nothing to apply')
    return NextResponse.json(result)
  } catch (err) {
    console.error('[credit-notes/apply]', err)
    return apiError(500, 'apply_failed', err instanceof Error ? err.message : String(err))
  }
}
