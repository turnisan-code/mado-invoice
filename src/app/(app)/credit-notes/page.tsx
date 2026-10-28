import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import CreditNoteList, { type CreditNote } from '@/components/lists/CreditNoteList'

export default async function CreditNotesPage() {
  const supabase = await createClient()

  // A credit note is settled by refunds (its own payments) and by 'credit' rows on the invoice
  // it was applied to, which only point back through credit_note_id.
  const [{ data: docs }, { data: credits }] = await Promise.all([
    supabase
      .from('documents')
      .select('id, number, status, date, currency, tax_treatment, discount_type, discount_value, clients(name, company), document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount, kind)')
      .eq('type', 'credit_note')
      .order('date', { ascending: false }),
    supabase.from('payments').select('credit_note_id, amount').eq('kind', 'credit'),
  ])

  const applied = new Map<string, number>()
  for (const row of credits ?? []) {
    if (row.credit_note_id) applied.set(row.credit_note_id, (applied.get(row.credit_note_id) ?? 0) + Number(row.amount))
  }
  const rows = ((docs ?? []) as unknown as CreditNote[]).map(d => ({ ...d, applied: applied.get(d.id) ?? 0 }))

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <Suspense>
        <CreditNoteList docs={rows} />
      </Suspense>
    </div>
  )
}
