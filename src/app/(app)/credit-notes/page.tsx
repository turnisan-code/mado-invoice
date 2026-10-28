import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import CreditNoteList, { type CreditNote } from '@/components/lists/CreditNoteList'

export default async function CreditNotesPage() {
  const supabase = await createClient()

  const { data: docs } = await supabase
    .from('documents')
    .select('id, number, status, date, currency, tax_treatment, discount_type, discount_value, clients(name, company), document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)')
    .eq('type', 'credit_note')
    .order('date', { ascending: false })

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <Suspense>
        <CreditNoteList docs={(docs ?? []) as unknown as CreditNote[]} />
      </Suspense>
    </div>
  )
}
