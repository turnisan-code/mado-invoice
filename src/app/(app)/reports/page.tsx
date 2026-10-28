import Link from 'next/link'
import { AlertTriangle, DatabaseBackup, Download, FileArchive } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { calcTotals, formatMoney, formatDate, roundCents, today } from '@/lib/utils/document'
import ReportControls from '@/components/layout/ReportControls'
import { getT } from '@/lib/i18n/server'
import { n } from '@/lib/i18n'
import { parsePeriod, periodLabel, periodParams, MIN_YEAR, type PeriodParams } from './period'
import { fetchZmRows } from './zm'

// FinanzOnline field names stay German in both UI languages.
const KZ: Record<number, { base: string; vat: string }> = {
  20: { base: 'KZ 022 — 20 % Normalsteuersatz, Bemessungsgrundlage', vat: 'USt 20 %' },
  13: { base: 'KZ 006 — 13 % ermäßigter Steuersatz, Bemessungsgrundlage', vat: 'USt 13 %' },
  10: { base: 'KZ 029 — 10 % ermäßigter Steuersatz, Bemessungsgrundlage', vat: 'USt 10 %' },
  0:  { base: 'Steuerfreie Umsätze 0 %, Bemessungsgrundlage', vat: 'USt 0 %' },
}

type ClientRef = { name: string; company: string | null } | null
type DocRow = {
  id: string
  number: string | null
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  document_items: Parameters<typeof calcTotals>[0]
  clients?: ClientRef
}
function docTotals(d: DocRow) {
  return calcTotals(
    d.document_items ?? [],
    [],
    d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
    d.tax_treatment,
  )
}
const clientName = (c: ClientRef | undefined) => c ? c.company || c.name : ''

const card = 'bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden'
const cardHead = 'px-5 py-4 border-b border-neutral-100 dark:border-neutral-800'
const fileLink = 'flex items-center gap-1.5 text-sm px-3 py-2 sm:py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-neutral-700 dark:text-neutral-300'

export default async function ReportsPage({ searchParams }: { searchParams: Promise<PeriodParams> }) {
  const { t, lang } = await getT()
  const now = today()
  const period = parsePeriod(await searchParams, now)
  const label = periodLabel(period, lang, t('reports.yearLabel', { year: period.year }))
  const query = periodParams(period).toString()

  const supabase = await createClient()
  const itemCols = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'
  const [{ data: payments }, { data: creditNotes }, zm] = await Promise.all([
    supabase
      .from('payments')
      .select(`id, amount, date, method, document_id, documents!inner(id, number, type, tax_treatment, discount_type, discount_value, ${itemCols}, clients(name, company))`)
      .eq('documents.type', 'invoice')
      .eq('kind', 'payment')
      .gte('date', period.start)
      .lte('date', period.end)
      .order('date'),
    supabase
      .from('documents')
      .select(`id, number, date, converted_from_id, tax_treatment, discount_type, discount_value, ${itemCols}, clients(name, company)`)
      .eq('type', 'credit_note')
      .eq('status', 'sent')
      .gte('date', period.start)
      .lte('date', period.end)
      .order('date'),
    fetchZmRows(supabase, period.start, period.end),
  ])
  const cns = (creditNotes ?? []) as unknown as (DocRow & { date: string; converted_from_id: string | null })[]
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
  const countedPayments: { id: string; date: string; amount: number; method: string; doc: DocRow }[] = []
  for (const p of payments ?? []) {
    const d = p.documents as unknown as DocRow
    const total = docTotals(d).total
    if (!total) continue
    invoiceIds.add(d.id)
    add(d, p.amount / total)
    countedPayments.push({ id: p.id, date: p.date, amount: p.amount, method: p.method, doc: d })
  }
  // Credit notes reverse turnover in the period of their document date — but a credit note
  // on an invoice can only give back money that was actually received (a Storno of an unpaid
  // invoice changes nothing). Standalone credit notes are deducted in full.
  const countedCredits: { doc: DocRow & { date: string }; amount: number }[] = []
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
    countedCredits.push({ doc: cn, amount: roundCents(refundable) })
    add(cn, -refundable / creditTotal)
  }
  const creditNoteCount = countedCredits.length

  const rates = Object.keys(vat).map(Number).sort((a, b) => b - a)
  const taxableBase = roundCents(rates.reduce((s, r) => s + vat[r].base, 0))
  const totalVat = roundCents(rates.reduce((s, r) => s + vat[r].vat, 0))
  rcBase = roundCents(rcBase)
  nonEuBase = roundCents(nonEuBase)
  const netTotal = roundCents(taxableBase + rcBase + nonEuBase)
  const currentYear = Number(now.slice(0, 4))
  const years = Array.from(new Set([...Array.from({ length: 6 }, (_, i) => currentYear - i), period.year]))
    .filter(y => y >= MIN_YEAR)
    .sort((a, b) => b - a)
  const paymentCount = countedPayments.length
  const zmTotal = roundCents(zm.rows.reduce((s, r) => s + r.net, 0))
  const zmMissingUid = zm.rows.some(r => !r.uid)
  const exportHref = (kind: string) => `/api/export/accounting?kind=${kind}&${query}`

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{t('reports.title')}</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{t('reports.subtitle')}</p>
        </div>
        <ReportControls period={period} years={years} />
      </div>

      <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl px-5 py-4 text-sm text-amber-800 dark:text-amber-300">
        {t('reports.period')} <strong>{label}</strong> ({formatDate(period.start, lang)} – {formatDate(period.end, lang)}) · {n(paymentCount, t('reports.paymentsOne', { count: paymentCount }), t('reports.paymentsOther', { count: paymentCount }))} {n(invoiceIds.size, t('reports.onInvoicesOne', { count: invoiceIds.size }), t('reports.onInvoicesOther', { count: invoiceIds.size }))}
        {creditNoteCount > 0 && <> · {n(creditNoteCount, t('reports.creditNotesDeductedOne', { count: creditNoteCount }), t('reports.creditNotesDeductedOther', { count: creditNoteCount }))}</>}
      </div>

      <div className={card}>
        <div className={cardHead}>
          <h2 className="font-medium text-sm">{t('exports.uva.title')}</h2>
        </div>
        <div className="divide-y divide-neutral-50 dark:divide-neutral-800 text-sm">
          <Row label="KZ 000 — Gesamtbetrag der Bemessungsgrundlage (steuerbare Umsätze)" value={formatMoney(taxableBase)} />
          {rates.map(r => (
            <div key={r}>
              <Row label={KZ[r]?.base ?? `${r} % — Bemessungsgrundlage`} value={formatMoney(roundCents(vat[r].base))} />
              <Row label={KZ[r]?.vat ?? `USt ${r} %`} value={formatMoney(roundCents(vat[r].vat))} bold />
            </div>
          ))}
          {rcBase !== 0 && <Row label={t('exports.uva.reverseCharge')} value={formatMoney(rcBase)} note={t('exports.uva.reverseChargeNote')} />}
          {nonEuBase !== 0 && <Row label={t('exports.uva.nonEu')} value={formatMoney(nonEuBase)} note={t('exports.uva.nonEuNote')} />}
          <div className="px-5 py-4 flex justify-between items-center gap-4 bg-neutral-50 dark:bg-neutral-800">
            <span className="font-semibold">{t('exports.uva.totalVat')}</span>
            <span className="font-semibold text-base shrink-0">{formatMoney(totalVat)}</span>
          </div>
        </div>
      </div>

      <div className={card}>
        <div className={`${cardHead} flex items-start justify-between gap-4 flex-wrap`}>
          <div className="min-w-0 flex-1">
            <h2 className="font-medium text-sm">{t('exports.zm.title')}</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{t('exports.zm.hint')}</p>
          </div>
          {zm.rows.length > 0 && (
            <a href={exportHref('zm')} className={fileLink}>
              <Download size={14} /> {t('exports.zm.download')}
            </a>
          )}
        </div>
        {zm.error ? (
          <p role="alert" className="px-5 py-4 text-sm text-red-600 dark:text-red-400">{t('exports.zm.loadFailed', { error: zm.error })}</p>
        ) : zm.rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-neutral-500 dark:text-neutral-400 text-center">{t('exports.zm.none')}</p>
        ) : (
          <>
            {zmMissingUid && (
              <p className="px-5 py-3 flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-100 dark:border-amber-900">
                <AlertTriangle size={14} className="shrink-0 mt-px" aria-hidden="true" />
                {t('exports.zm.missingUidHint')}
              </p>
            )}
            <ul className="divide-y divide-neutral-50 dark:divide-neutral-800 text-sm">
              {zm.rows.map(row => (
                <li key={row.key} className="px-5 py-3 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{row.client || '—'}</div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      {row.uid
                        ? <span className="font-mono">{row.uid}</span>
                        : <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 font-medium">{t('exports.zm.missingUid')}</span>}
                      {row.documents.map(d => (
                        <Link key={d.id} href={`/${d.type === 'credit_note' ? 'credit-notes' : 'invoices'}/${d.id}`} className="underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-200">
                          {d.number}
                        </Link>
                      ))}
                    </div>
                  </div>
                  <span className="shrink-0 font-medium tabular-nums">{formatMoney(row.net)}</span>
                </li>
              ))}
              <li className="px-5 py-3 flex justify-between gap-4 bg-neutral-50 dark:bg-neutral-800 font-semibold">
                <span>{t('exports.zm.total')}</span>
                <span className="tabular-nums">{formatMoney(zmTotal)}</span>
              </li>
            </ul>
          </>
        )}
      </div>

      <div className={card}>
        <div className={cardHead}>
          <h2 className="font-medium text-sm">{t('reports.summary')}</h2>
        </div>
        <div className="divide-y divide-neutral-50 dark:divide-neutral-800 text-sm">
          <Row label={t('reports.netTotal')} value={formatMoney(netTotal)} />
          <Row label={t('reports.vat')} value={formatMoney(totalVat)} />
          <Row label={t('reports.gross')} value={formatMoney(roundCents(netTotal + totalVat))} bold />
        </div>
      </div>

      <details className={`${card} group`}>
        <summary className="px-5 py-4 cursor-pointer select-none font-medium text-sm flex items-center justify-between gap-4 list-none [&::-webkit-details-marker]:hidden">
          <span>{t('exports.included.title')}</span>
          <span className="text-xs font-normal text-neutral-500 dark:text-neutral-400">{paymentCount + creditNoteCount} <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-180">▾</span></span>
        </summary>
        <div className="border-t border-neutral-100 dark:border-neutral-800 text-sm">
          <h3 className="px-5 pt-4 pb-2 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{t('exports.included.payments')}</h3>
          {countedPayments.length === 0 ? (
            <p className="px-5 pb-4 text-neutral-500 dark:text-neutral-400">{t('exports.included.none')}</p>
          ) : (
            <ul className="divide-y divide-neutral-50 dark:divide-neutral-800">
              {countedPayments.map(p => (
                <li key={p.id} className="px-5 py-2.5 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Link href={`/invoices/${p.doc.id}`} className="font-medium hover:underline">{p.doc.number ?? t('common.draft')}</Link>
                    <span className="text-neutral-500 dark:text-neutral-400"> · {clientName(p.doc.clients) || '—'}</span>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {formatDate(p.date, lang)} · {p.method === 'cash' ? t('payments.methodCash') : t('payments.methodBank')}
                    </div>
                  </div>
                  <span className="shrink-0 tabular-nums">{formatMoney(p.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="px-5 pt-4 pb-2 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{t('exports.included.creditNotes')}</h3>
          {countedCredits.length === 0 ? (
            <p className="px-5 pb-4 text-neutral-500 dark:text-neutral-400">{t('exports.included.none')}</p>
          ) : (
            <ul className="divide-y divide-neutral-50 dark:divide-neutral-800">
              {countedCredits.map(c => (
                <li key={c.doc.id} className="px-5 py-2.5 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Link href={`/credit-notes/${c.doc.id}`} className="font-medium hover:underline">{c.doc.number ?? t('common.draft')}</Link>
                    <span className="text-neutral-500 dark:text-neutral-400"> · {clientName(c.doc.clients) || '—'}</span>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">{formatDate(c.doc.date, lang)}</div>
                  </div>
                  <span className="shrink-0 tabular-nums">−{formatMoney(c.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <div className={card}>
        <div className={cardHead}>
          <h2 className="font-medium text-sm">{t('reports.exportTitle')}</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{t('reports.exportHint', { period: label })}</p>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div className="flex gap-3 flex-wrap">
            <a href={exportHref('documents')} className={fileLink}>
              <Download size={14} /> {t('reports.exportDocuments', { period: label })}
            </a>
            <a href={exportHref('payments')} className={fileLink}>
              <Download size={14} /> {t('reports.exportPayments', { period: label })}
            </a>
          </div>
          <div className="space-y-1.5">
            <a href={exportHref('pdfs')} className={`${fileLink} w-fit`}>
              <FileArchive size={14} /> {t('exports.files.pdfs', { period: label })}
            </a>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('exports.files.pdfsHint', { period: label })}</p>
          </div>
          <div className="space-y-1.5">
            <a href="/api/export/accounting?kind=backup" className={`${fileLink} w-fit`}>
              <DatabaseBackup size={14} /> {t('exports.files.backup')}
            </a>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('exports.files.backupHint')}</p>
          </div>
        </div>
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {t('reports.footnote')}
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
