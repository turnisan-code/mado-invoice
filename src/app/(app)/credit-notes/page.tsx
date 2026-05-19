import { createClient } from '@/lib/supabase/server'
import CreditNoteList from '@/components/lists/CreditNoteList'

export default async function CreditNotesPage() {
  const supabase = await createClient()

  const { data: docs } = await supabase
    .from('documents')
    .select('*, clients(name, company), document_items(*)')
    .eq('type', 'credit_note')
    .order('date', { ascending: false })

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <CreditNoteList docs={docs ?? []} />
    </div>
  )
}
