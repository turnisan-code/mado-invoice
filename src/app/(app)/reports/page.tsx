import { createClient } from '@/lib/supabase/server'
import { calcTotals, formatMoney, formatDate, roundCents, today } from '@/lib/utils/document'
import ReportControls from '@/components/layout/ReportControls'
import { Suspense } from 'react'
import { Download } from 'lucide-react'

const KZ: Record<number, { base: string; vat: string }> = {
  20: { base: 'KZ 022 — 20 % Normalsteuersatz, Bemessungsgrundlage', vat: 'USt 20 %' },
  13: { base: 'KZ 006 — 13 % ermäßigter Steuersatz, Bemessungsgrundlage', vat: 'USt 13 %' },
  10: { base: 'KZ 029 — 10 % ermäßigter Steuersatz, Bemessungsgrundlage', vat: 'USt 10 %' },
  0:  { base: 'Steuerfreie Umsätze 0 %, Bemessungsgrundlage', vat: 'USt 0 %' },
}

function periodFor(year: number, quarter: number) {
  if (quarter === 0) return { start: `${year}-01-01`, end: `${year}-12-31`, label: `Jahr ${year}` }
  const m1 = (quarter - 1) * 3 + 1
  const m3 = quarter * 3
  const lastDay = new Date(year, m3, 0).getDate()
  return {
    start: `${year}-${String(m1).padStart(2, '0')}-01`,
    end: `${year}-${String(m3).padStart(2, '0')}-${lastDay}`,
    label: `Q${quarter} ${year}`,
  }
}

type DocRow = {
  id: string
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  document_items: Parameters<typeof calcTotals>[0]
}
function docTotals(d: DocRow) {
  return calcTotals(
    d.document_items ?? [],
    [],
    d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
    d.tax_treatment,
  )
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ year?: string; quarter?: string }> }) {
  const { year: yearParam, quarter: quarterParam } = await searchParams
  const now = today()
  const currentYear = Number(now.slice(0, 4))
  const year = parseInt(yearParam ?? '', 10) || currentYear
  const quarter = quarterParam === 'all' ? 0 : (parseInt(quarterParam ?? '', 10) || Math.ceil(Number(now.slice(5, 7)) / 3))
  const period = periodFor(year, quarter)

  const supabase = await createClient()
  const itemCols = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'
  const [{ data: payments }, { data: creditNotes }] = await Promise.all([
    supabase
      .from('payments')
      .select(`amount, date, document_id, documents!inner(id, type, tax_treatment, discount_type, discount_value, ${itemCols})`)
      .eq('documents.type', 'invoice')
      .eq('kind', 'payment')
      .gte('date', period.start)
      .lte('date', period.end),
    supabase
      .from('documents')
      .select(`id, date, converted_from_id, tax_treatment, discount_type, discount_value, ${itemCols}`)
      .eq('type', 'credit_note')
      .eq('status', 'sent')
      .gte('date', period.start)
      .lte('date', period.end),
  ])
  const cns = (creditNotes ?? []) as (DocRow & { converted_from_id: string | null })[]
  const originalIds = cns.map(c => c.converted_from_id).filter((x): x is string => !!x)
  const { data: originals } = originalIds.length
    ? await supabase.from('documents').select(`id, tax_treatment, discount_type, discount_value, ${itemCols}, payments(amount, date, kind)`).in('id', originalIds)
    : { data: [] as unknown[] }
  const originalById = new Map((originals ?? []).map(o => [(o as DocRow).id, o as DocRow & { payments: { amount: number; date: string; kind: string }[] }]))

  const vat: Record<number, { base: number; vat: number }> = {}
  let rcBase = 0
  let nonEuBase = 0
  const invoiceIds = new Set<string>()

  function add(d: DocRow, share: number) {
    const t = docTotals(d)
    const net = t.subtotal - t.discount_amount
    if (d.tax_treatment === 'eu_reverse_charge') rcBase += net * share
    else if (d.tax_treatment === 'non_eu') nonEuBase += net * share
    else {
      for (const g of t.vat_groups) {
        vat[g.rate] = vat[g.rate] ?? { base: 0, vat: 0 }
        vat[g.rate].base += g.base * share
        vat[g.rate].vat += g.amount * share
      }
    }
  }

  // Ist-Besteuerung: a payment counts in the period it was received, partial payments
  // proportionally. Only money that arrived (kind = payment) is turnover: a Skonto taken or a
  // write-off closes the invoice without revenue.
  for (const p of payments ?? []) {
    const d = p.documents as unknown as DocRow
    const total = docTotals(d).total
    if (!total) continue
    invoiceIds.add(d.id)
    add(d, p.amount / total)
  }
  // Credit notes reverse turnover in the period of their document date — but a credit note
  // on an invoice can only give back money that was actually received (a Storno of an unpaid
  // invoice changes nothing). Standalone credit notes are deducted in full.
  let creditNoteCount = 0
  for (const cn of cns) {
    const creditTotal = docTotals(cn).total
    if (!creditTotal) continue
    let refundable = creditTotal
    const original = cn.converted_from_id ? originalById.get(cn.converted_from_id) : undefined
    if (original) {
      const paid = (original.payments ?? []).filter(p => p.kind === 'payment' && p.date && p.date <= period.end).reduce((s, p) => s + p.amount, 0)
      refundable = Math.min(creditTotal, Math.max(0, paid + creditTotal - docTotals(original).total))
    }
    if (refundable <= 0) continue
    creditNoteCount++
    add(cn, -refundable / creditTotal)
  }

  const rates = Object.keys(vat).map(Number).sort((a, b) => b - a)
  const taxableBase = roundCents(rates.reduce((s, r) => s + vat[r].base, 0))
  const totalVat = roundCents(rates.reduce((s, r) => s + vat[r].vat, 0))
  rcBase = roundCents(rcBase)
  nonEuBase = roundCents(nonEuBase)
  const netTotal = roundCents(taxableBase + rcBase + nonEuBase)
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i)
  const paymentCount = payments?.length ?? 0

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">UVA-Report</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">Ist-Besteuerung — Beträge nach Zahlungseingang, zum Übertragen in FinanzOnline.</p>
        </div>
        <Suspense>
          <ReportControls year={year} quarter={quarter} years={years} />
        </Suspense>
      </div>

      <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl px-5 py-4 text-sm text-amber-800 dark:text-amber-300">
        Zeitraum <strong>{period.label}</strong> ({formatDate(period.start)} – {formatDate(period.end)}) · {paymentCount} Zahlungseingang{paymentCount !== 1 ? 'e' : ''} auf {invoiceIds.size} Rechnung{invoiceIds.size !== 1 ? 'en' : ''}
        {creditNoteCount > 0 && <> · {creditNoteCount} Gutschrift{creditNoteCount !== 1 ? 'en' : ''} abgezogen</>}
      </div>

      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
          <span className="font-medium text-sm">Umsatzsteuervoranmeldung (UVA)</span>
        </div>
        <div className="divide-y divide-neutral-50 dark:divide-neutral-800 text-sm">
          <Row label="KZ 000 — Gesamtbetrag der Bemessungsgrundlage (steuerbare Umsätze)" value={formatMoney(taxableBase)} />
          {rates.map(r => (
            <div key={r}>
              <Row label={KZ[r]?.base ?? `${r} % — Bemessungsgrundlage`} value={formatMoney(roundCents(vat[r].base))} />
              <Row label={KZ[r]?.vat ?? `USt ${r} %`} value={formatMoney(roundCents(vat[r].vat))} bold />
            </div>
          ))}
          {rcBase !== 0 && <Row label="Nicht steuerbar — Reverse Charge EU (B2B-Leistungen)" value={formatMoney(rcBase)} note="nicht in KZ 000 · in der ZM melden" />}
          {nonEuBase !== 0 && <Row label="Nicht steuerbar — Drittland" value={formatMoney(nonEuBase)} note="nicht in KZ 000" />}
          <div className="px-5 py-4 flex justify-between items-center bg-neutral-50 dark:bg-neutral-800">
            <span className="font-semibold">Umsatzsteuer gesamt (vor Vorsteuer)</span>
            <span className="font-semibold text-base">{formatMoney(totalVat)}</span>
          </div>
        </div>
      </div>

      {rcBase !== 0 && (
        <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-xl px-5 py-4 text-sm text-blue-800 dark:text-blue-300">
          <strong>Zusammenfassende Meldung (ZM):</strong> Reverse-Charge-Leistungen an EU-Unternehmer in diesem Zeitraum: {formatMoney(rcBase)}. In FinanzOnline je Empfänger-UID melden.
        </div>
      )}

      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
          <span className="font-medium text-sm">Zusammenfassung</span>
        </div>
        <div className="divide-y divide-neutral-50 dark:divide-neutral-800 text-sm">
          <Row label="Nettoumsatz gesamt (inkl. nicht steuerbar)" value={formatMoney(netTotal)} />
          <Row label="Umsatzsteuer" value={formatMoney(totalVat)} />
          <Row label="Bruttoeinnahmen" value={formatMoney(roundCents(netTotal + totalVat))} bold />
        </div>
      </div>

      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
          <span className="font-medium text-sm">Export für Steuerberater</span>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">CSV für Excel (de-AT): alle ausgestellten Rechnungen und Gutschriften bzw. alle Zahlungseingänge des Jahres {year}.</p>
        </div>
        <div className="px-5 py-4 flex gap-3 flex-wrap">
          <a href={`/api/export/accounting?year=${year}&kind=documents`} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-neutral-700 dark:text-neutral-300">
            <Download size={14} /> Belege {year}
          </a>
          <a href={`/api/export/accounting?year=${year}&kind=payments`} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-neutral-700 dark:text-neutral-300">
            <Download size={14} /> Zahlungen {year}
          </a>
        </div>
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Teilzahlungen werden anteilig berücksichtigt; Skonto und Abschreibungen sind keine Einnahmen und zählen nicht. Gutschriften und Stornos werden mit ihrem Belegdatum abgezogen, aber nur soweit auf die Ursprungsrechnung tatsächlich Zahlungen eingegangen sind. Vorsteuer aus Eingangsrechnungen ist nicht enthalten — die Zahllast ergibt sich in Bookamat.
      </p>
    </div>
  )
}

function Row({ label, value, bold = false, note }: { label: string; value: string; bold?: boolean; note?: string }) {
  return (
    <div className="px-5 py-3 flex justify-between items-center gap-4">
      <div>
        <span className={bold ? 'font-medium' : 'text-neutral-600 dark:text-neutral-400'}>{label}</span>
        {note && <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">{note}</span>}
      </div>
      <span className={`shrink-0 ${bold ? 'font-semibold' : ''}`}>{value}</span>
    </div>
  )
}
