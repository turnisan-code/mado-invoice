import Link from 'next/link'
import { AlertTriangle, DatabaseBackup, Download, FileArchive } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { calcTotals, formatMoney, formatDate, roundCents, today } from '@/lib/utils/document'
import ReportControls from '@/components/layout/ReportControls'
import { getT } from '@/lib/i18n/server'
import { n } from '@/lib/i18n'
import { parsePeriod, periodLabel, periodParams, MAX_PDFS, MIN_YEAR, type PeriodParams } from './period'
import { fetchZmRows } from './zm'
import { istTurnover, type InvoiceHistory } from './ist'
import { creditNoteOpen } from '@/lib/status'
import { unappliedCreditNotes } from '@/lib/credits'
import ApplyCreditNotesButton from '@/components/layout/ApplyCreditNotesButton'
import { clientDisplayName as clientName } from '@/lib/utils/clients'

// FinanzOnline field names stay German in both UI languages; everything else follows the UI.
const KZ_BASE: Record<number, string> = {
  20: 'KZ 022 — 20 % Normalsteuersatz, Bemessungsgrundlage',
  13: 'KZ 006 — 13 % ermäßigter Steuersatz, Bemessungsgrundlage',
  10: 'KZ 029 — 10 % ermäßigter Steuersatz, Bemessungsgrundlage',
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
  const docCols = `id, number, date, type, tax_treatment, discount_type, discount_value, ${itemCols}, clients(name, company)`
  const [{ data: payments }, { data: credits }, { data: refunds }, { data: openCreditNotes }, zm, { count: issuedCount }, unapplied, { data: feeRows }] = await Promise.all([
    supabase
      .from('payments')
      .select(`id, amount, date, method, document_id, documents!inner(${docCols})`)
      .eq('documents.type', 'invoice')
      .eq('kind', 'payment')
      .gte('date', period.start)
      .lte('date', period.end)
      .order('date'),
    // Every credit note applied to its invoice (rows on the invoice): a credit before the period
    // changes how the period's payments split, and the open ones below need all of them.
    supabase
      .from('payments')
      .select(`id, amount, date, credit_note_id, documents!inner(${docCols})`)
      .eq('documents.type', 'invoice')
      .eq('kind', 'credit')
      .order('date'),
    // Money paid back on credit notes in the period.
    supabase
      .from('payments')
      .select(`id, amount, date, method, documents!inner(${docCols})`)
      .eq('documents.type', 'credit_note')
      .eq('kind', 'refund')
      .gte('date', period.start)
      .lte('date', period.end)
      .order('date'),
    // Issued credit notes up to the period end, to point out the ones not settled yet.
    supabase
      .from('documents')
      .select(`${docCols}, payments(amount, kind)`)
      .eq('type', 'credit_note')
      .eq('status', 'sent')
      .not('number', 'is', null)
      .lte('date', period.end)
      .order('date'),
    fetchZmRows(supabase, period.start, period.end),
    supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .in('type', ['invoice', 'credit_note'])
      .not('number', 'is', null)
      .gte('date', period.start)
      .lte('date', period.end),
    unappliedCreditNotes(supabase).catch(err => {
      console.error('[reports] unapplied credit notes:', err)
      return []
    }),
    // Dunning fees and interest received: money, but no turnover; only mentioned.
    supabase.from('payments').select('amount').eq('kind', 'fee').gte('date', period.start).lte('date', period.end),
  ])
  const feesReceived = roundCents((feeRows ?? []).reduce((s, r) => s + Number(r.amount), 0))
  type Dated = DocRow & { date: string }
  const creditRows = (credits ?? []) as unknown as { id: string; amount: number; date: string; credit_note_id: string; documents: Dated }[]
  const refundRows = (refunds ?? []) as unknown as { id: string; amount: number; date: string; method: string; documents: Dated }[]
  const unsettledCns = (openCreditNotes ?? []) as unknown as (Dated & { payments: { amount: number; kind: string }[] | null })[]
  // Ist-Besteuerung (see ist.ts): money received on invoices, split at the rates left after the
  // credit notes applied to them, and refunds paid on credit notes, each in the period it
  // happened. Skonto and write-offs close invoices without revenue and are not read at all.
  const invoiceIds = new Set<string>()
  const countedPayments: { id: string; date: string; amount: number; method: string; doc: DocRow }[] = []
  for (const p of payments ?? []) {
    const d = p.documents as unknown as DocRow
    if (!docTotals(d).total) continue
    invoiceIds.add(d.id)
    countedPayments.push({ id: p.id, date: p.date, amount: p.amount, method: p.method, doc: d })
  }
  const inPeriod = (date: string) => date >= period.start && date <= period.end
  const periodCredits = creditRows.filter(r => inPeriod(r.date))
  // Invoices the period touches (a payment or a credit in it) need their history: credits up to
  // its end re-split the money, and money received before it caps what still counts (an
  // overpayment is no turnover).
  const touched = new Set([...invoiceIds, ...periodCredits.map(r => r.documents.id)])
  const historyCredits = creditRows.filter(r => r.date <= period.end && touched.has(r.documents.id))
  // payments.credit_note_id has no embeddable foreign key, so the credit notes are looked up by id.
  const cnIds = [...new Set(historyCredits.map(r => r.credit_note_id))]
  const touchedIds = [...touched]
  const [{ data: cnDocs }, earlierPayments] = await Promise.all([
    cnIds.length
      ? supabase.from('documents').select(docCols).in('id', cnIds)
      : Promise.resolve({ data: [] as unknown[] }),
    // .in() filters travel in the URL: a year's invoices are looked up in slices.
    Promise.all(Array.from({ length: Math.ceil(touchedIds.length / 100) }, (_, i) =>
      supabase.from('payments').select('document_id, date, amount').eq('kind', 'payment').in('document_id', touchedIds.slice(i * 100, i * 100 + 100)).lt('date', period.start),
    )).then(results => results.flatMap(r => {
      if (r.error) console.error('[reports] earlier payments:', r.error.message)
      return r.data ?? []
    })),
  ])
  const cnById = new Map(((cnDocs ?? []) as unknown as Dated[]).map(d => [d.id, d]))

  const histories = new Map<string, InvoiceHistory>()
  const historyOf = (doc: DocRow) => {
    let h = histories.get(doc.id)
    if (!h) histories.set(doc.id, h = { invoice: doc, payments: [], credits: [] })
    return h
  }
  for (const p of countedPayments) historyOf(p.doc).payments.push({ date: p.date, amount: p.amount })
  const applied: { id: string; date: string; amount: number; invoice: Dated; creditNote: Dated }[] = []
  for (const r of historyCredits) {
    const creditNote = cnById.get(r.credit_note_id)
    if (!creditNote) continue
    historyOf(r.documents).credits.push({ date: r.date, amount: r.amount, creditNote })
    if (inPeriod(r.date)) applied.push({ id: r.id, date: r.date, amount: r.amount, invoice: r.documents, creditNote })
  }
  for (const p of earlierPayments as { document_id: string; date: string; amount: number }[]) {
    histories.get(p.document_id)?.payments.push({ date: p.date, amount: p.amount })
  }
  const refunded = refundRows.map(r => ({ id: r.id, date: r.date, amount: r.amount, creditNote: r.documents }))
  const { vat, rcBase: rcRaw, nonEuBase: nonEuRaw } = istTurnover({
    start: period.start,
    end: period.end,
    invoices: [...histories.values()],
    refunded,
  })
  const rcBase = roundCents(rcRaw)
  const nonEuBase = roundCents(nonEuRaw)

  const countedCredits = [
    ...applied.map(a => ({ key: `a-${a.id}`, doc: a.creditNote, date: a.date, amount: a.amount, appliedTo: a.invoice.number ?? '' })),
    ...refunded.map(r => ({ key: `r-${r.id}`, doc: r.creditNote, date: r.date, amount: r.amount, appliedTo: null })),
  ].sort((a, b) => a.date.localeCompare(b.date))
  const creditNoteCount = new Set(countedCredits.map(c => c.doc.id)).size
  // Only refunds take turnover off; an applied credit moves no money.
  const deductedCount = new Set(refunded.map(r => r.creditNote.id)).size

  const appliedByCn = new Map<string, number>()
  for (const r of creditRows) {
    appliedByCn.set(r.credit_note_id, (appliedByCn.get(r.credit_note_id) ?? 0) + r.amount)
  }
  const unsettled = unsettledCns
    .map(cn => ({
      doc: cn,
      open: creditNoteOpen(
        docTotals(cn).total,
        appliedByCn.get(cn.id) ?? 0,
        (cn.payments ?? []).filter(p => p.kind === 'refund').reduce((s, p) => s + p.amount, 0),
      ),
    }))
    .filter(c => c.open > 0.005)

  // A credit can leave a rate at zero (its line credited in full): no row for it.
  const rates = Object.keys(vat).map(Number)
    .filter(r => roundCents(vat[r].base) !== 0 || roundCents(vat[r].vat) !== 0)
    .sort((a, b) => b - a)
  const taxableBase = roundCents(rates.reduce((s, r) => s + vat[r].base, 0))
  const totalVat = roundCents(rates.reduce((s, r) => s + vat[r].vat, 0))
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
        {deductedCount > 0 && <> · {n(deductedCount, t('reports.creditNotesDeductedOne', { count: deductedCount }), t('reports.creditNotesDeductedOther', { count: deductedCount }))}</>}
      </div>

      {unsettled.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl px-5 py-4 text-sm text-amber-800 dark:text-amber-300 space-y-2">
          <div className="flex items-start gap-2 flex-wrap sm:flex-nowrap">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span className="flex-1 min-w-0"><strong>{t('lifecycle.reports.unsettledTitle')}</strong> — {t('lifecycle.reports.unsettledHint')}</span>
            {unapplied.length > 0 && <ApplyCreditNotesButton />}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 pl-6">
            {unsettled.map(c => (
              <li key={c.doc.id}>
                <Link href={`/credit-notes/${c.doc.id}`} className="underline underline-offset-2 font-medium">{c.doc.number}</Link>
                {' '}{t('lifecycle.reports.unsettledRow', { amount: formatMoney(c.open) })}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={card}>
        <div className={cardHead}>
          <h2 className="font-medium text-sm">{t('exports.uva.title')}</h2>
        </div>
        <div className="divide-y divide-neutral-50 dark:divide-neutral-800 text-sm">
          <Row label="KZ 000 — Gesamtbetrag der Bemessungsgrundlage (steuerbare Umsätze)" value={formatMoney(taxableBase)} />
          {rates.map(r => (
            <div key={r}>
              <Row label={KZ_BASE[r] ?? (r === 0 ? t('views.reports.exemptBase') : t('views.reports.rateBase', { rate: r }))} value={formatMoney(roundCents(vat[r].base))} />
              <Row label={t('views.reports.vatAt', { rate: r })} value={formatMoney(roundCents(vat[r].vat))} bold />
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
          {feesReceived > 0 && (
            <p className="px-5 py-3 text-xs text-neutral-500 dark:text-neutral-400">{t('books.fees.reportsNote', { amount: formatMoney(feesReceived) })}</p>
          )}
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
                <li key={c.key} className="px-5 py-2.5 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Link href={`/credit-notes/${c.doc.id}`} className="font-medium hover:underline">{c.doc.number ?? t('common.draft')}</Link>
                    <span className="text-neutral-500 dark:text-neutral-400"> · {clientName(c.doc.clients) || '—'}</span>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {formatDate(c.date, lang)} · {c.appliedTo !== null ? t('lifecycle.reports.applied', { number: c.appliedTo }) : t('lifecycle.reports.refunded')}
                    </div>
                  </div>
                  {/* An applied credit settles the invoice without money: it only moves turnover between rates. */}
                  <span className={`shrink-0 tabular-nums ${c.appliedTo !== null ? 'text-neutral-500 dark:text-neutral-400' : ''}`}>{c.appliedTo !== null ? '±' : '−'}{formatMoney(c.amount)}</span>
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
            {issuedCount === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('exports.files.pdfsNone', { period: label })}</p>
            ) : issuedCount != null && issuedCount > MAX_PDFS ? (
              <p className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                {t('exports.files.tooMany', { count: issuedCount })}
              </p>
            ) : (
              <>
                <a href={exportHref('pdfs')} className={`${fileLink} w-fit`}>
                  <FileArchive size={14} /> {t('exports.files.pdfs', { period: label })}
                </a>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('exports.files.pdfsHint', { period: label })}</p>
              </>
            )}
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
        {t('lifecycle.reports.footnote')}
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
