import { NextResponse } from 'next/server'
import { apiError, databaseError, isUuid, requireUser } from '@/lib/auth'
import { convertQuote } from '@/lib/services/quotes'
import { asDbError } from '@/lib/status'

// The quote's invoice (convertQuote); the existing one when it was converted before.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  if (!isUuid(id)) return apiError(404, 'not_found', 'Not found')

  try {
    const result = await convertQuote(supabase, id)
    if (!result) return apiError(404, 'not_found', 'Quote not found')
    return NextResponse.json({ invoiceId: result.invoiceId, existing: result.existing })
  } catch (err) {
    // MI019: the quote has advance invoices, so its invoice is the final invoice that deducts them.
    const error = asDbError(err)
    return databaseError(error, error.code === 'MI016' || error.code === 'MI019' ? 409 : 500)
  }
}
