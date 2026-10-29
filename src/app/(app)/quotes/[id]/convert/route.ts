import { NextResponse } from 'next/server'
import { apiError, databaseError, isUuid, requireUser } from '@/lib/auth'
import { logEvent } from '@/lib/events'

type Converted = { invoice_id: string; existing: boolean; quote_status: string }

// convert_quote_to_invoice does the whole conversion in one transaction (status check, unnumbered
// draft invoice due after the client's payment days, every line, quote → accepted) and hands
// back the existing invoice when the quote was converted before.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  if (!isUuid(id)) return apiError(404, 'not_found', 'Not found')

  const { data, error } = await supabase.rpc('convert_quote_to_invoice', { p_quote_id: id })
  if (error) return databaseError(error, error.code === 'MI016' ? 409 : 500)
  const result = data as Converted | null
  if (!result) return apiError(404, 'not_found', 'Quote not found')

  if (!result.existing) {
    const { data: quote } = await supabase.from('documents').select('number').eq('id', id).single()
    await logEvent(supabase, result.invoice_id, 'converted', { from_id: id, from_number: quote?.number ?? null, from_type: 'quote' })
    // The invoice is still an unnumbered draft; the quote's history links to it by id.
    await logEvent(supabase, id, 'converted', { to_id: result.invoice_id, to_type: 'invoice' })
    if (result.quote_status === 'sent') await logEvent(supabase, id, 'status_changed', { from: 'sent', to: 'accepted' })
  }

  return NextResponse.json({ invoiceId: result.invoice_id, existing: result.existing })
}
