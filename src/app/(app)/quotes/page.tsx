import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import QuoteList, { type Quote } from '@/components/lists/QuoteList'
import { listDocuments } from '@/lib/services/queries'

export default async function QuotesPage() {
  const supabase = await createClient()

  const { data: docs } = await listDocuments(supabase, 'quote')

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <Suspense>
        <QuoteList quotes={(docs ?? []) as unknown as Quote[]} />
      </Suspense>
    </div>
  )
}
