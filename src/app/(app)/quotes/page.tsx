import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import QuoteList, { type Quote } from '@/components/lists/QuoteList'

export default async function QuotesPage() {
  const supabase = await createClient()

  const { data: docs } = await supabase
    .from('documents')
    .select('id, number, status, date, due_date, currency, tax_treatment, discount_type, discount_value, clients(name, company), document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)')
    .eq('type', 'quote')
    .order('date', { ascending: false })

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <Suspense>
        <QuoteList quotes={(docs ?? []) as unknown as Quote[]} />
      </Suspense>
    </div>
  )
}
