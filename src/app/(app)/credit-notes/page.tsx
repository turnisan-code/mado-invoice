import { createClient } from '@/lib/supabase/server'
import CreditNoteList from '@/components/lists/CreditNoteList'

export default async function CreditNotesPage() {
  const supabase = await createClient()

  const { data: docs } = await supabase
    .from('documents')
    .select('*, clients(name, company), document_items(line_type, quantity, unit_price, vat_rate)')
    .eq('type', 'credit_note')
    .order('date', { ascending: false })

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <CreditNoteList docs={docs ?? []} />
    </div>
  )
}
