import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import CreditNoteList, { type CreditNote } from '@/components/lists/CreditNoteList'
import { listDocuments } from '@/lib/services/queries'

export default async function CreditNotesPage() {
  const supabase = await createClient()

  const { data: docs } = await listDocuments(supabase, 'credit_note')
  const rows = (docs ?? []) as unknown as CreditNote[]

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <Suspense>
        <CreditNoteList docs={rows} />
      </Suspense>
    </div>
  )
}
