import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { calcTotals, roundCents } from '@/lib/utils/document'
import ClientList, { type ClientRow } from '@/components/lists/ClientList'

export default async function ClientsPage() {
  const supabase = await createClient()

  const [{ data: clients }, { data: issued }, { data: open }] = await Promise.all([
    supabase.from('clients').select('id, name, company, email, phone, address_line1, address_line2, zip, city, country, uid_number, tax_treatment, language, payment_days, status, tags').order('name'),
    // Drafts are not invoiced yet and a cancelled invoice was taken back by its Storno.
    supabase.from('documents').select('client_id, date').eq('type', 'invoice').in('status', ['sent', 'paid', 'overdue']).order('date', { ascending: false }),
    supabase
      .from('documents')
      .select('client_id, tax_treatment, discount_type, discount_value, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount)')
      .eq('type', 'invoice')
      .in('status', ['sent', 'overdue']),
  ])

  const lastInvoicedMap: Record<string, string> = {}
  for (const inv of issued ?? []) {
    if (inv.client_id && !lastInvoicedMap[inv.client_id]) lastInvoicedMap[inv.client_id] = inv.date
  }

  // Same basis as the client page's "Open balance": what is still owed on issued, unpaid invoices.
  const balanceMap: Record<string, number> = {}
  for (const d of open ?? []) {
    const { balance_due } = calcTotals(
      d.document_items ?? [],
      d.payments ?? [],
      d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
      d.tax_treatment,
    )
    balanceMap[d.client_id] = roundCents((balanceMap[d.client_id] ?? 0) + balance_due)
  }

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <Suspense>
        <ClientList clients={(clients ?? []) as ClientRow[]} lastInvoicedMap={lastInvoicedMap} balanceMap={balanceMap} />
      </Suspense>
    </div>
  )
}
