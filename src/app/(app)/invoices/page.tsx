import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import InvoiceList, { type Invoice } from '@/components/lists/InvoiceList'
import { isBookamatConfigured } from '@/lib/public-settings'

export default async function InvoicesPage() {
  const supabase = await createClient()

  const [{ data: docs, error: docsError }, { data: schedules }, { data: settings }, { t }] = await Promise.all([
    supabase
      .from('documents')
      .select('id, number, status, date, due_date, currency, client_id, tax_treatment, discount_type, discount_value, pdf_path, bookamat_error, bookamat_booking_id, clients(name, company), document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount, kind), bookamat_bookings(year, booking_id)')
      .eq('type', 'invoice')
      .order('date', { ascending: false }),
    supabase.from('recurring_schedules').select('source_document_id'),
    supabase.from('settings').select('bookamat_username, bookamat_api_key, bookamat_bank_account_id, bookamat_cost_account_id').maybeSingle(),
    getT(),
  ])

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-4">
      {/* An empty list would hide the failure, e.g. a deploy ahead of its migration. */}
      {docsError && (
        <p role="alert" className="px-4 py-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-sm text-red-700 dark:text-red-300 break-words">
          {t('books.invoicesLoadFailed', { error: docsError.message })}
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
