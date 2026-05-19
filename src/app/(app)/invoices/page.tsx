import { createClient } from '@/lib/supabase/server'
import InvoiceList from '@/components/lists/InvoiceList'
import { markOverdueInvoices } from '@/lib/utils/overdue'

export default async function InvoicesPage() {
  const supabase = await createClient()
  await markOverdueInvoices(supabase)

  const { data: docs } = await supabase
    .from('documents')
    .select('*, clients(name, company), document_items(*)')
    .eq('type', 'invoice')
    .order('date', { ascending: false })

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <InvoiceList invoices={docs ?? []} />
    </div>
  )
}
