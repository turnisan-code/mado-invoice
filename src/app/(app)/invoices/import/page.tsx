import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import { calcTotals, roundCents } from '@/lib/utils/document'
import { isBookamatConfigured } from '@/lib/public-settings'
import BankImport from '@/components/bank/BankImport'
import type { OpenInvoice } from '@/lib/bank/match'

const INVOICE_COLS = 'id, number, date, due_date, tax_treatment, discount_type, discount_value, skonto_percent, skonto_days, reminder_level, clients(name, company), document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount, kind)'

export default async function BankImportPage() {
  const supabase = await createClient()
  const { t } = await getT()

  const [{ data: docs }, { data: refs }, { data: settings }] = await Promise.all([
    supabase.from('documents').select(INVOICE_COLS).eq('type', 'invoice').in('status', ['sent', 'overdue']).not('number', 'is', null).order('date', { ascending: true }),
    supabase.from('payments').select('import_ref').not('import_ref', 'is', null),
    supabase.from('settings').select('bookamat_username, bookamat_api_key, bookamat_bank_account_id, bookamat_cost_account_id, quote_prefix, credit_note_prefix').single(),
  ])

  // Oldest first, so a client's repeated credits settle their invoices in order.
  const invoices: OpenInvoice[] = (docs ?? []).flatMap(d => {
    const totals = calcTotals(
      d.document_items ?? [],
      d.payments ?? [],
      d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
      d.tax_treatment,
    )
    if (!d.number || totals.balance_due <= 0.005) return []
    // PostgREST types the to-one relation as an array; at runtime it is a single row.
    const client = (Array.isArray(d.clients) ? d.clients[0] : d.clients) as { name: string; company: string | null } | null | undefined
    return [{
      id: d.id,
      number: d.number,
      clientName: client?.name ?? '',
      clientCompany: client?.company ?? null,
      date: d.date,
      dueDate: d.due_date ?? null,
      total: totals.total,
      paid: totals.total_paid,
      balance: roundCents(totals.balance_due),
      skontoPercent: d.skonto_percent ?? null,
      skontoDays: d.skonto_days ?? null,
      reminderLevel: d.reminder_level ?? 0,
    }]
  })
  // The Skonto and fee rows of a transaction carry its id with a suffix; any of them marks it imported.
  const importedRefs = [...new Set((refs ?? []).map(r => (r.import_ref as string).replace(/:(?:skonto|fee)$/, '')))]
  const bookamatConfigured = !!settings && isBookamatConfigured(settings)

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-start gap-3">
        <Link href="/invoices" aria-label={t('bankImport.backToInvoices')} className="h-11 w-11 -m-3.5 mt-[-0.5rem] inline-flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors shrink-0">
          <ArrowLeft size={16} />
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold">{t('bankImport.title')}</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{t('bankImport.intro')}</p>
        </div>
      </div>
      <BankImport invoices={invoices} importedRefs={importedRefs} bookamatConfigured={bookamatConfigured} otherPrefixes={[settings?.quote_prefix ?? 'A', settings?.credit_note_prefix ?? 'G']} />
    </div>
  )
}
