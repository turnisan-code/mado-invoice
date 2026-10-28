import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import InvoiceList from '@/components/lists/InvoiceList'

export default async function InvoicesPage() {
  const supabase = await createClient()

  const [{ data: docs }, { data: schedules }] = await Promise.all([
    supabase
      .from('documents')
      .select('*, clients(name, company), document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount)')
      .eq('type', 'invoice')
      .order('date', { ascending: false }),
    supabase.from('recurring_schedules').select('source_document_id'),
  ])

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <Suspense>
        <InvoiceList invoices={docs ?? []} recurringSourceIds={(schedules ?? []).map(s => s.source_document_id)} />
      </Suspense>
    </div>
  )
}
