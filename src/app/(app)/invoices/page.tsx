import { createClient } from '@/lib/supabase/server'
import InvoiceList from '@/components/lists/InvoiceList'

export default async function InvoicesPage() {
  const supabase = await createClient()

  const { data: docs } = await supabase
    .from('documents')
    .select('*, clients(name, company), document_items(*)')
    .eq('type', 'invoice')
    .order('date', { ascending: false })

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <InvoiceList invoices={docs ?? []} />
    </div>
  )
}
