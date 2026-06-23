import { createClient } from '@/lib/supabase/server'
import InvoiceList from '@/components/lists/InvoiceList'

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const supabase = await createClient()
  const { status } = await searchParams

  const { data: docs } = await supabase
    .from('documents')
    .select('*, clients(name, company), document_items(line_type, quantity, unit_price, vat_rate)')
    .eq('type', 'invoice')
    .order('date', { ascending: false })

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <InvoiceList invoices={docs ?? []} initialStatus={status} />
    </div>
  )
}
