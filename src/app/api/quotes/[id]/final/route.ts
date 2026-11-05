import { NextResponse } from 'next/server'
import { apiError, databaseError, isUuid, requireUser } from '@/lib/auth'
import { writeDeductions } from '@/lib/deposits'
import { logEvent } from '@/lib/events'

type Converted = { invoice_id: string; existing: boolean; quote_status: string; linked: number }

// The final invoice (Schlussrechnung) of a quote: convert_quote_to_invoice with p_final copies
// every line into a draft final invoice and links the quote's issued advance and partial invoices
// in one transaction; the deduction lines (per invoice and VAT rate) are written here. Hands back
// the existing invoice when the quote was converted before.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Quote not found')

  // The refusals (MI016: not convertible, MI019–MI022: the deposit guards) keep their code; the
  // browser words them.
  const { data, error } = await supabase.rpc('convert_quote_to_invoice', { p_quote_id: id, p_final: true })
  if (error) return databaseError(error, error.code === 'MI016' || error.code?.startsWith('MI02') ? 409 : 500)
  const result = data as Converted | null
  if (!result) return apiError(404, 'not_found', 'Quote not found')
  if (result.existing) return NextResponse.json({ invoiceId: result.invoice_id, existing: true })

  const { data: quote } = await supabase.from('documents').select('number').eq('id', id).single()
  await logEvent(supabase, result.invoice_id, 'converted', { from_id: id, from_number: quote?.number ?? null, from_type: 'quote' })
  await logEvent(supabase, id, 'converted', { to_id: result.invoice_id, to_type: 'invoice' })
  if (result.quote_status === 'sent') await logEvent(supabase, id, 'status_changed', { from: 'sent', to: 'accepted' })

  // A failure leaves a draft without its deduction lines; the editor writes them when it opens.
  try {
    await writeDeductions(supabase, result.invoice_id)
  } catch (err) {
    console.error(`[quotes/final] deductions of ${result.invoice_id} not written:`, err)
  }
  return NextResponse.json({ invoiceId: result.invoice_id, existing: false })
}
