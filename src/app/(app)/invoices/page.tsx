import { createClient } from '@/lib/supabase/server'
import InvoiceList from '@/components/lists/InvoiceList'
import { markOverdueInvoices } from '@/lib/utils/overdue'

export default async function InvoicesPage() {
  const supabase = await createClient()
  void markOverdueInvoices(supabase)

  const { data: docs } = await supabase
    .from('documents')
    .select('id, number, date, due_date, status, currency, clients(name, company), document_items(quantity, unit_price, vat_rate)')
    .eq('type', 'invoice')
    .order('date', { ascending: false })

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <InvoiceList invoices={docs ?? []} />
    </div>
  )
}
