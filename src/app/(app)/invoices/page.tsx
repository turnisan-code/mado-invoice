import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import InvoiceList, { type Invoice } from '@/components/lists/InvoiceList'
import { isBookamatConfigured } from '@/lib/public-settings'
import { listDocuments } from '@/lib/services/queries'

export default async function InvoicesPage() {
  const supabase = await createClient()

  const [{ data: docs, error: docsError }, { data: schedules }, { data: settings }, { t }] = await Promise.all([
    listDocuments(supabase, 'invoice'),
    supabase.from('recurring_schedules').select('source_document_id'),
    supabase.from('settings').select('bookamat_username, bookamat_api_key, bookamat_bank_account_id, bookamat_cost_account_id').maybeSingle(),
    getT(),
  ])
  if (docsError) console.error('[invoices] list not loaded:', docsError.code, docsError.message)

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-4">
      {/* An empty list would hide the failure, e.g. a deploy ahead of its migration (the cause is in the server log). */}
      {docsError && (
        <p role="alert" className="px-4 py-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-sm text-red-700 dark:text-red-300 break-words">
          {t('books.invoicesLoadFailed')}
        </p>
      )}
      <Suspense>
        <InvoiceList
          invoices={(docs ?? []) as unknown as Invoice[]}
          recurringSourceIds={(schedules ?? []).map(s => s.source_document_id)}
          bookamatConfigured={!!settings && isBookamatConfigured(settings)}
        />
      </Suspense>
    </div>
  )
}
