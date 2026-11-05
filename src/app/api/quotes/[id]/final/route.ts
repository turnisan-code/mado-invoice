import { NextResponse } from 'next/server'
import { apiError, databaseError, isUuid, requireUser } from '@/lib/auth'
import { convertQuote } from '@/lib/services/quotes'
import { asDbError } from '@/lib/status'

// The final invoice (Schlussrechnung) of a quote (convertQuote with final); the existing invoice
// when the quote was converted before.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Quote not found')

  try {
    const result = await convertQuote(supabase, id, { final: true })
    if (!result) return apiError(404, 'not_found', 'Quote not found')
    return NextResponse.json({ invoiceId: result.invoiceId, existing: result.existing })
  } catch (err) {
    // The refusals (MI016: not convertible, MI019–MI022: the deposit guards) keep their code; the
    // browser words them.
    const error = asDbError(err)
    return databaseError(error, error.code === 'MI016' || error.code?.startsWith('MI02') ? 409 : 500)
  }
}
