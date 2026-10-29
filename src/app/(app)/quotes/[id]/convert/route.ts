import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { logEvent } from '@/lib/events'
import { lifecycleErrorMessage } from '@/lib/status'
import { getT } from '@/lib/i18n/server'

type Converted = { invoice_id: string; existing: boolean; quote_status: string }

// convert_quote_to_invoice does the whole conversion in one transaction (status check, unnumbered
// draft invoice due after the client's payment days, every line, quote → accepted) and hands
// back the existing invoice when the quote was converted before.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { t } = await getT()

  const { data, error } = await supabase.rpc('convert_quote_to_invoice', { p_quote_id: id })
  // MI019: the quote has advance invoices, so its invoice is the final invoice that deducts them.
  if (error?.code === 'MI019') return NextResponse.json({ error: t('deposits.errors.useFinal'), code: error.code }, { status: 409 })
  if (error) return NextResponse.json({ error: lifecycleErrorMessage(error, t), code: error.code }, { status: error.code === 'MI016' ? 409 : 500 })
  const result = data as Converted | null
  if (!result) return NextResponse.json({ error: t('lifecycle.errors.notFound') }, { status: 404 })

  if (!result.existing) {
    const { data: quote } = await supabase.from('documents').select('number').eq('id', id).single()
    await logEvent(supabase, result.invoice_id, 'converted', { from_id: id, from_number: quote?.number ?? null, from_type: 'quote' })
    // The invoice is still an unnumbered draft; the quote's history links to it by id.
    await logEvent(supabase, id, 'converted', { to_id: result.invoice_id, to_type: 'invoice' })
    if (result.quote_status === 'sent') await logEvent(supabase, id, 'status_changed', { from: 'sent', to: 'accepted' })
  }

  return NextResponse.json({ invoiceId: result.invoice_id, existing: result.existing })
}
