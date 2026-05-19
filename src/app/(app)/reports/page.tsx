import { createClient } from '@/lib/supabase/server'
import { formatMoney } from '@/lib/utils/document'
import ReportControls from '@/components/layout/ReportControls'
import { Suspense } from 'react'

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ year?: string; quarter?: string }> }) {
  const { year: yearParam, quarter: quarterParam } = await searchParams
  const currentYear = new Date().getFullYear()
  const year = parseInt(yearParam ?? String(currentYear), 10)
  const quarter = parseInt(quarterParam ?? String(Math.ceil((new Date().getMonth() + 1) / 3)), 10)

  const qStart = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`
  const qEndMonth = quarter * 3
  const qEnd = `${year}-${String(qEndMonth).padStart(2, '0')}-${qEndMonth === 3 || qEndMonth === 12 ? 31 : qEndMonth === 6 ? 30 : qEndMonth === 9 ? 30 : 31}`

  const supabase = await createClient()
  const { data: docs } = await supabase
    .from('documents')
    .select('*, document_items(*)')
    .eq('type', 'invoice')
    .in('status', ['sent', 'paid', 'overdue'])
    .gte('date', qStart)
    .lte('date', qEnd)

  const yearDocs = docs ?? []

  type VatGroup = { base: number; vat: number }
  let subtotal = 0
  const vatMap: Record<string, VatGroup> = {}
  let reverseChargeBase = 0
  let nonEUBase = 0

  for (const doc of yearDocs) {
    for (const item of (doc.document_items ?? [])) {
      if (item.quantity == null || item.unit_price == null) continue
      const net = item.quantity * item.unit_price
      if (net === 0) continue
      subtotal += net
      if (doc.tax_treatment === 'at_vat') {
        const key = String(item.vat_rate ?? 0)
        if (!vatMap[key]) vatMap[key] = { base: 0, vat: 0 }
        vatMap[key].base += net
        vatMap[key].vat += net * ((item.vat_rate ?? 0) / 100)
      } else if (doc.tax_treatment === 'eu_reverse_charge') {
        reverseChargeBase += net
      } else {
        nonEUBase += net
      }
    }
  }

  const totalVat = Object.values(vatMap).reduce((s, g) => s + g.vat, 0)
  const gross = subtotal + totalVat

  const years = Array.from({ length: 5 }, (_, i) => currentYear - i)

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">VAT Report</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">Copy these figures into FinanzOnline.</p>
        </div>
        <Suspense>
          <ReportControls year={year} quarter={quarter} years={years} />
        </Suspense>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 text-sm text-amber-800">
        Period: <strong>{qStart}</strong> – <strong>{qEnd}</strong> · {yearDocs.length} invoice{yearDocs.length !== 1 ? 's' : ''} included (sent, paid, overdue)
      </div>

      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
          <span className="font-medium text-sm">Umsatzsteuervoranmeldung (UVA)</span>
        </div>
        <div className="divide-y divide-neutral-50 dark:divide-neutral-800 text-sm">
          <Row label="Gesamtumsatz netto (Kennzahl 000)" value={formatMoney(subtotal)} />
          {Object.entries(vatMap).sort(([a], [b]) => parseInt(b) - parseInt(a)).map(([rate, g]) => (
            <div key={rate}>
              <Row label={`Steuerpflichtige Umsätze ${rate}% (Bemessungsgrundlage)`} value={formatMoney(g.base)} />
              <Row label={`USt. ${rate}%`} value={formatMoney(g.vat)} bold />
            </div>
          ))}
          {reverseChargeBase > 0 && <Row label="Innergemeinschaftliche Leistungen (Reverse Charge)" value={formatMoney(reverseChargeBase)} note="→ ZM meldepflichtig" />}
          {nonEUBase > 0 && <Row label="Nicht steuerbare Auslandsumsätze (Non-EU)" value={formatMoney(nonEUBase)} />}
          <div className="px-5 py-4 flex justify-between items-center bg-neutral-50 dark:bg-neutral-800">
            <span className="font-semibold">Zahllast USt gesamt</span>
            <span className="font-semibold text-base">{formatMoney(totalVat)}</span>
          </div>
        </div>
      </div>

      {reverseChargeBase > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4 text-sm text-blue-800">
          <strong>Zusammenfassende Meldung (ZM):</strong> EU Reverse Charge volume this quarter: {formatMoney(reverseChargeBase)}. Report this in FinanzOnline under ZM.
        </div>
      )}

      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
          <span className="font-medium text-sm">Summary</span>
        </div>
        <div className="divide-y divide-neutral-50 dark:divide-neutral-800 text-sm">
          <Row label="Net revenue" value={formatMoney(subtotal)} />
          <Row label="VAT collected" value={formatMoney(totalVat)} />
          <Row label="Gross revenue" value={formatMoney(gross)} bold />
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, bold = false, note }: { label: string; value: string; bold?: boolean; note?: string }) {
  return (
    <div className="px-5 py-3 flex justify-between items-center">
      <div>
        <span className={bold ? 'font-medium' : 'text-neutral-600 dark:text-neutral-400'}>{label}</span>
        {note && <span className="ml-2 text-xs text-neutral-400 dark:text-neutral-500">{note}</span>}
      </div>
      <span className={bold ? 'font-semibold' : ''}>{value}</span>
    </div>
  )
}
