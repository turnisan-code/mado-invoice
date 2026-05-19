import { createClient } from '@/lib/supabase/server'
import QuoteList from '@/components/lists/QuoteList'

export default async function QuotesPage() {
  const supabase = await createClient()

  const { data: docs } = await supabase
    .from('documents')
    .select('*, clients(name, company), document_items(*)')
    .eq('type', 'quote')
    .order('date', { ascending: false })

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <QuoteList quotes={docs ?? []} />
    </div>
  )
}
