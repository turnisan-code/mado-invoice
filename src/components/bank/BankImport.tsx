'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { formatDate, formatMoney, roundCents } from '@/lib/utils/document'
import { applyMapping } from '@/lib/bank/parse'
import { matchTransactions, preTicked, toggledSelection, type MatchRow, type OpenInvoice } from '@/lib/bank/match'
import type { BankTransaction, CsvMapping, ParsedStatement } from '@/lib/bank/types'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey, type TFn, type UiLang } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-errors'
import { clientDisplayName } from '@/lib/utils/clients'

// A statement as the page read it (lib/bank/parse.ts): the „Kontoauszug“ page holds it, so both
// tabs work on the one file.
export interface LoadedStatement {
  parsed: ParsedStatement
  fileName: string
}

interface Props {
  statement: LoadedStatement | null
  onStatement: (statement: LoadedStatement | null) => void
  // A generic CSV's columns mapped again: the same file, read anew
  onRemap?: (statement: LoadedStatement) => void
  invoices: OpenInvoice[]
  importedRefs: string[]
  bookamatConfigured: boolean
  /** Quote and credit-note prefixes: their numbers in a remittance text are never an invoice. */
  otherPrefixes: string[]
  /** Invoices no longer open: a credit naming one is most likely recorded already. */
  closedInvoices: { id: string; number: string }[]
}

interface ImportResponse {
  imported: number
  duplicates: number
  paid: string[]
  /** Recorded as dunning fees / interest beyond the open balances. */
  fees?: number
  errors: { transaction_id: string; code?: 'not_found' | 'not_issued' | 'cancelled' | 'date_future' | 'bank_fees'; message: string }[]
}

interface InvoiceLabel { id: string; number: string; client: string }

interface ImportResult extends ImportResponse {
  /** Labels captured when the import started: after router.refresh() the paid invoices leave `invoices`. */
  invoices: InvoiceLabel[]
}

const CHECKBOX_CLS = 'h-4 w-4 shrink-0 rounded border-neutral-300 dark:border-neutral-600 accent-blue-500 disabled:opacity-40'
const PILL: Record<string, string> = {
  high: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  medium: 'text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300',
  manual: 'text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300',
  none: 'text-neutral-500 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-400',
}
const WARNING_CODES = ['reversal', 'noDate', 'noAmount', 'fewCells', 'noHeader', 'noEntries', 'xml', 'unmapped'] as const
export const MAX_WARNINGS = 8

// Bank exports occasionally print a symbol instead of an ISO code; Intl would throw on it.
const money = (amount: number, currency: string | null) => formatMoney(amount, currency && /^[A-Z]{3}$/.test(currency) ? currency : 'EUR')
const noteFor = (tx: BankTransaction) => [tx.counterparty, tx.text].filter(Boolean).join(' · ').slice(0, 200) || null
const percent = (p: number, lang: UiLang) => new Intl.NumberFormat(lang === 'de' ? 'de-AT' : 'en-GB', { maximumFractionDigits: 2 }).format(p)

export function warningText(w: string, t: TFn): string {
  const i = w.indexOf(':')
  const code = i < 0 ? w : w.slice(0, i)
  const detail = i < 0 ? '' : w.slice(i + 1)
  const key = WARNING_CODES.find(c => c === code)
  return key ? t(`bankImport.warn.${key}`, { detail }) : w
}

function MappingEditor({ header, rows, mapping, onChange, t }: { header: string[]; rows: string[][]; mapping: CsvMapping; onChange: (m: CsvMapping) => void; t: TFn }) {
  const name = (i: number) => header[i] || `#${i + 1}`

  // A signed amount column and a credit/debit pair are alternatives; picking one clears the other.
  function setColumn(key: 'date' | 'amount' | 'credit' | 'debit' | 'counterparty' | 'currency', raw: string) {
    const value = raw === '' ? null : Number(raw)
    const next = { ...mapping, [key]: value }
    if (key === 'amount' && value !== null) { next.credit = null; next.debit = null }
    if ((key === 'credit' || key === 'debit') && value !== null) next.amount = null
    onChange(next)
  }

  const column = (label: string, key: 'date' | 'amount' | 'credit' | 'debit' | 'counterparty' | 'currency') => (
    <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
      <span className="block font-medium">{label}</span>
      <Select value={mapping[key] ?? ''} onChange={e => setColumn(key, e.target.value)}>
        <option value="">{t('bankImport.colNone')}</option>
        {header.map((_, i) => <option key={i} value={i}>{name(i)}</option>)}
      </Select>
    </label>
  )

  return (
    <div className="space-y-3 pt-3 border-t border-neutral-100 dark:border-neutral-800">
      <div>
        <h3 className="text-sm font-semibold">{t('bankImport.mappingTitle')}</h3>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('bankImport.mappingHint')}</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {column(t('bankImport.colDate'), 'date')}
        {column(t('bankImport.colAmount'), 'amount')}
        {column(t('bankImport.colCredit'), 'credit')}
        {column(t('bankImport.colDebit'), 'debit')}
        {column(t('bankImport.colCounterparty'), 'counterparty')}
        {column(t('bankImport.colCurrency'), 'currency')}
      </div>
      <fieldset>
        <legend className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('bankImport.colText')}</legend>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('bankImport.colTextHint')}</p>
        <div className="flex flex-wrap gap-2 mt-2">
          {header.map((_, i) => (
            <label key={i} className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 cursor-pointer">
              <input
                type="checkbox"
                className={CHECKBOX_CLS}
                checked={mapping.text.includes(i)}
                onChange={e => onChange({ ...mapping, text: e.target.checked ? [...mapping.text, i].sort((a, b) => a - b) : mapping.text.filter(x => x !== i) })}
              />
              {name(i)}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">{t('bankImport.preview')}</p>
        <div className="overflow-x-auto rounded-md border border-neutral-100 dark:border-neutral-800">
          <table className="text-xs whitespace-nowrap">
            <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">
              <tr>{header.map((_, i) => <th key={i} className="px-2 py-1.5 text-left font-medium">{name(i)}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
              {rows.slice(0, 5).map((r, ri) => (
                <tr key={ri}>{header.map((_, i) => <td key={i} className="px-2 py-1.5 max-w-48 truncate" title={r[i]}>{r[i]}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default function BankImport({ statement, onStatement, onRemap, invoices, importedRefs, bookamatConfigured, otherPrefixes, closedInvoices }: Props) {
  const { t, lang } = useT()
  const router = useRouter()
  // The page keys this component by the statement: a new file starts a new review
  const parsed = statement?.parsed ?? null
  // Per transaction: a chosen invoice id ('' = skip), a checkbox override and an opted-out Skonto.
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [selection, setSelection] = useState<Record<string, boolean>>({})
  const [skontoOff, setSkontoOff] = useState<Record<string, boolean>>({})
  // „Rest als Bankspesen“, ticked by the owner only.
  const [bankFeesOn, setBankFeesOn] = useState<Record<string, boolean>>({})
  const [skippedOpen, setSkippedOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmOverpay, setConfirmOverpay] = useState(false)
  // What the credits beyond an open balance are: dunning fees and interest, or an overpayment.
  const [excessAs, setExcessAs] = useState<'fee' | 'payment'>('fee')
  const [result, setResult] = useState<ImportResult | null>(null)

  const plural = (count: number, one: DictKey, other: DictKey) => n(count, t(one, { count }), t(other, { count }))

  const imported = useMemo(() => new Set(importedRefs), [importedRefs])
  const invoiceById = useMemo(() => new Map(invoices.map(i => [i.id, i])), [invoices])
  const rows = useMemo(
    () => (parsed ? matchTransactions(parsed.transactions, invoices, imported, { otherPrefixes, closed: closedInvoices }) : []),
    [parsed, invoices, imported, otherPrefixes, closedInvoices],
  )
  const txById = useMemo(() => new Map(rows.map(r => [r.transaction.id, r.transaction])), [rows])
  const credits = rows.filter(r => r.status === 'match' || r.status === 'unmatched')
  const skipped = rows.filter(r => r.status !== 'match' && r.status !== 'unmatched')

  const invoiceFor = (r: MatchRow) => (r.transaction.id in edits ? edits[r.transaction.id] || null : r.invoiceId)
  // Ticked without the owner's look: only a credit naming the invoice's number whole. One found
  // by its amount, the client's name or the Skonto keeps its suggestion, unticked (another
  // client paying the same amount must not land on this invoice).
  const manual = (r: MatchRow) => r.transaction.id in edits && !!edits[r.transaction.id]
  const byNumber = (r: MatchRow) => preTicked(r) && invoiceFor(r) === r.invoiceId
  const isChecked = (r: MatchRow) => !!invoiceFor(r) && (selection[r.transaction.id] ?? byNumber(r))
  const skontoFor = (r: MatchRow) => (r.skontoAmount > 0 && invoiceFor(r) === r.invoiceId && !skontoOff[r.transaction.id] ? r.skontoAmount : 0)
  const bankFeesFor = (r: MatchRow) => (r.bankFees > 0 && invoiceFor(r) === r.invoiceId && bankFeesOn[r.transaction.id] ? r.bankFees : 0)

  const chosen = credits.filter(isChecked)
  const chosenTotal = chosen.reduce((s, r) => s + r.transaction.amount, 0)
  const currency = credits.find(r => r.transaction.currency)?.transaction.currency ?? null
  const assignable = credits.filter(r => !!invoiceFor(r))
  // „Alle“ ticks the number matches and what the owner assigned by hand, never a guess.
  const bulk = assignable.filter(r => byNumber(r) || manual(r))
  const allChecked = bulk.length > 0 && bulk.every(isChecked)

  // Selected credits (with their Skonto) per invoice against the balance the page loaded with:
  // a manual re-assignment or two ticks on one invoice can exceed it, like an overpayment in PaymentPanel.
  const assigned = new Map<string, number>()
  for (const r of chosen) {
    const id = invoiceFor(r)!
    assigned.set(id, roundCents((assigned.get(id) ?? 0) + r.transaction.amount + skontoFor(r) + bankFeesFor(r)))
  }
  const excessFor = (invoiceId: string | null) => {
    const inv = invoiceId ? invoiceById.get(invoiceId) : undefined
    const sum = invoiceId ? assigned.get(invoiceId) : undefined
    return inv && sum !== undefined ? Math.max(0, roundCents(sum - inv.balance)) : 0
  }
  const overpaid = [...assigned.keys()].filter(id => excessFor(id) > 0.005)
  const excessTotal = roundCents(overpaid.reduce((s, id) => s + excessFor(id), 0))

  function resetReview() {
    setEdits({})
    setSelection({})
    setSkontoOff({})
    setBankFeesOn({})
    setSkippedOpen(false)
  }

  function reset() {
    setResult(null)
    resetReview()
    onStatement(null)
  }

  function remap(mapping: CsvMapping) {
    if (!statement || !parsed?.csv) return
    const { transactions, warnings } = applyMapping(parsed.csv.rows, mapping)
    const next = { ...statement, parsed: { ...parsed, transactions, warnings, csv: { ...parsed.csv, mapping } } }
    if (onRemap) onRemap(next)
    else onStatement(next)
    resetReview()
  }

  function setInvoice(r: MatchRow, value: string) {
    setEdits(e => ({ ...e, [r.transaction.id]: value }))
    setSelection(s => ({ ...s, [r.transaction.id]: value !== '' }))
  }

  // Ticking „Alle“ keeps what was ticked by hand; unticking clears every row.
  function toggleAll(checked: boolean) {
    setSelection(s => toggledSelection(s, bulk.map(r => r.transaction.id), assignable.map(r => r.transaction.id), checked))
  }

  async function doImport(allowOverpayment = false) {
    const payload = chosen.map(r => ({
      transaction_id: r.transaction.id,
      document_id: invoiceFor(r)!,
      date: r.transaction.date,
      amount: r.transaction.amount,
      note: noteFor(r.transaction),
      reference: r.transaction.reference,
      skonto_amount: skontoFor(r),
      ...(bankFeesFor(r) > 0 ? { bank_fees: bankFeesFor(r), bank_fees_note: t('payments.bankFeesNote') } : {}),
      ...(excessTotal > 0.005 && excessAs === 'fee' ? { excess: 'fee' as const } : {}),
    }))
    if (!payload.length) return
    if (excessTotal > 0.005 && !allowOverpayment) {
      // A reminded invoice paid with more than its balance is most likely a paid Mahnung (or a
      // Zahlungserinnerung from before it stopped charging interest). Only a pre-selection.
      setExcessAs(overpaid.some(id => (invoiceById.get(id)?.reminderLevel ?? 0) > 0) ? 'fee' : 'payment')
      setConfirmOverpay(true)
      return
    }
    setConfirmOverpay(false)
    // Snapshot the labels now: router.refresh() below drops the invoices this import pays off.
    const labels: InvoiceLabel[] = [...new Set(payload.map(p => p.document_id))].flatMap(id => {
      const inv = invoiceById.get(id)
      return inv ? [{ id, number: inv.number, client: clientDisplayName({ company: inv.clientCompany, name: inv.clientName }) }] : []
    })
    setBusy(true)
    const res = await fetch('/api/payments/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: payload }),
    }).catch(() => null)
    setBusy(false)
    if (!res?.ok) {
      const error = res ? apiErrorMessage(t, await res.json().catch(() => ({}))) : t('messages.network')
      toast.error(t('bankImport.importFailed', { error }))
      return
    }
    const response: ImportResponse | null = await res.json().catch(() => null)
    if (!response) { toast.error(t('bankImport.importFailed', { error: t('messages.generic') })); router.refresh(); return }
    setResult({ ...response, invoices: labels })
    router.refresh()
  }

  function pill(r: MatchRow) {
    const chosenId = invoiceFor(r)
    const kind = !chosenId ? 'none' : chosenId === r.invoiceId && r.confidence ? r.confidence : 'manual'
    const label = kind === 'high' ? t('bankImport.confidenceHigh') : kind === 'medium' ? t('bankImport.confidenceMedium') : kind === 'manual' ? t('bankImport.confidenceManual') : t('bankImport.confidenceNone')
    const reasons = kind === 'high' || kind === 'medium' ? r.reasons.map(reason => t(`bankImport.reason.${reason}`)).join(', ') : ''
    return (
      <div className="space-y-0.5">
        <span title={reasons || undefined} className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${PILL[kind]}`}>{label}</span>
        {reasons && <p className="text-[11px] text-neutral-500 dark:text-neutral-500 leading-tight">{reasons}</p>}
        {(kind === 'high' || kind === 'medium') && !r.exactNumber && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-tight">{t(r.reasons.includes('number') ? 'bankImport.numberPartHint' : 'bankImport.checkHint')}</p>
        )}
        {r.names && <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-tight">{t('bankImport.namesClosed', { number: r.names })}</p>}
      </div>
    )
  }

  function invoiceSelect(r: MatchRow) {
    return (
      <Select value={invoiceFor(r) ?? ''} onChange={e => setInvoice(r, e.target.value)} aria-label={t('bankImport.thInvoice')}>
        <option value="">{t('bankImport.skip')}</option>
        {invoices.map(inv => (
          <option key={inv.id} value={inv.id}>
            {t('bankImport.invoiceOption', { number: inv.number, client: clientDisplayName({ company: inv.clientCompany, name: inv.clientName }), balance: money(inv.balance, null) })}
          </option>
        ))}
      </Select>
    )
  }

  function skontoLine(r: MatchRow) {
    const inv = r.invoiceId ? invoiceById.get(r.invoiceId) : null
    if (!(r.skontoAmount > 0) || invoiceFor(r) !== r.invoiceId || !inv) return null
    return (
      <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300 cursor-pointer">
        <input type="checkbox" className={CHECKBOX_CLS} checked={!skontoOff[r.transaction.id]} onChange={e => setSkontoOff(s => ({ ...s, [r.transaction.id]: !e.target.checked }))} />
        {t('bankImport.skontoLine', { percent: percent(inv.skontoPercent ?? 0, lang), amount: money(r.skontoAmount, r.transaction.currency) })}
      </label>
    )
  }

  function bankFeesLine(r: MatchRow) {
    if (!(r.bankFees > 0) || invoiceFor(r) !== r.invoiceId) return null
    const amount = money(r.bankFees, r.transaction.currency)
    return (
      <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300 cursor-pointer" title={t('bankImport.bankFeesHint', { amount })}>
        <input type="checkbox" className={CHECKBOX_CLS} checked={!!bankFeesOn[r.transaction.id]} onChange={e => setBankFeesOn(s => ({ ...s, [r.transaction.id]: e.target.checked }))} />
        {t('bankImport.bankFeesLine', { amount })}
      </label>
    )
  }

  const spesen = (tx: BankTransaction) => (tx.fee ? t('bankImport.spesen', { amount: money(tx.fee, tx.currency) }) : null)

  // A payment of this amount is on the invoice already: entered by hand, or imported before.
  function recordedLine(r: MatchRow) {
    if (!r.recorded || invoiceFor(r) !== r.invoiceId) return null
    return (
      <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle size={12} className="shrink-0" /> {t('bankImport.recordedHint', { amount: money(r.recorded.amount, r.transaction.currency), date: formatDate(r.recorded.date, lang) })}
      </p>
    )
  }

  function overpayLine(r: MatchRow) {
    const excess = isChecked(r) ? excessFor(invoiceFor(r)) : 0
    if (excess <= 0.005) return null
    return (
      <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle size={12} className="shrink-0" /> {t('bankImport.overpayHint', { amount: money(excess, r.transaction.currency) })}
      </p>
    )
  }

  function rowCheckbox(r: MatchRow) {
    return (
      <input
        type="checkbox"
        className={CHECKBOX_CLS}
        checked={isChecked(r)}
        disabled={!invoiceFor(r)}
        aria-label={t('bankImport.selectRow', { amount: money(r.transaction.amount, r.transaction.currency), date: formatDate(r.transaction.date, lang) })}
        onChange={e => setSelection(s => ({ ...s, [r.transaction.id]: e.target.checked }))}
      />
    )
  }

  const statusLabel = (r: MatchRow) => r.status === 'debit' ? t('bankImport.statusDebit') : r.status === 'imported' ? t('bankImport.statusImported') : t('bankImport.statusNothingOpen')
  const skippedSummary = [
    [skipped.filter(r => r.status === 'debit').length, 'bankImport.skippedDebitsOne', 'bankImport.skippedDebitsOther'],
    [skipped.filter(r => r.status === 'imported').length, 'bankImport.skippedImportedOne', 'bankImport.skippedImportedOther'],
    [skipped.filter(r => r.status === 'nothing_open').length, 'bankImport.skippedNothingOpenOne', 'bankImport.skippedNothingOpenOther'],
  ] as const

  if (result) {
    return (
      <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6 space-y-4">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={18} className="text-green-600 dark:text-green-400" />
          <h2 className="text-base font-semibold">{t('bankImport.resultTitle')}</h2>
        </div>
        <ul className="text-sm space-y-1">
          <li>{plural(result.imported, 'bankImport.resultImportedOne', 'bankImport.resultImportedOther')}</li>
          {result.duplicates > 0 && <li className="text-neutral-500 dark:text-neutral-400">{plural(result.duplicates, 'bankImport.resultDuplicatesOne', 'bankImport.resultDuplicatesOther')}</li>}
          {(result.fees ?? 0) > 0.005 && <li className="text-neutral-500 dark:text-neutral-400">{t('books.fees.resultFees', { amount: money(result.fees ?? 0, currency) })}</li>}
          {result.errors.length > 0 && <li className="text-red-600 dark:text-red-400">{plural(result.errors.length, 'bankImport.resultErrorsOne', 'bankImport.resultErrorsOther')}</li>}
        </ul>
        {result.errors.length > 0 && (
          <ul className="text-xs text-neutral-600 dark:text-neutral-300 space-y-1">
            {result.errors.map((e, i) => {
              const tx = txById.get(e.transaction_id)
              return (
                <li key={i}>
                  {tx ? `${formatDate(tx.date, lang)} · ${money(tx.amount, tx.currency)} · ${tx.counterparty ?? ''}` : e.transaction_id}
                  {' — '}{e.code ? t(`bankImport.error.${e.code}`) : t('messages.api.database')}
                </li>
              )
            })}
          </ul>
        )}
        {result.paid.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">{t('bankImport.resultPaid')}</h3>
            <ul className="flex flex-wrap gap-2">
              {result.paid.map(id => {
                const inv = result.invoices.find(i => i.id === id)
                return (
                  <li key={id}>
                    <Link href={`/invoices/${id}`} className="text-sm px-2.5 py-1 rounded-md bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300 hover:underline underline-offset-2">
                      {inv ? [inv.number, inv.client].filter(Boolean).join(' · ') : id}
                    </Link>
                  </li>
                )
              })}
            </ul>
            {bookamatConfigured && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
                <Link href="/invoices?bookamat=unsynced" className="underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-200">{t('bankImport.bookamatHint')}</Link>
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" onClick={reset} className="px-4">{t('bankImport.another')}</Button>
          <Link href="/invoices" className={buttonVariants({ variant: 'outline' })}>{t('bankImport.backToInvoices')}</Link>
        </div>
      </section>
    )
  }

  return (
    <div className="space-y-4">
      {/* The file itself: the page's (StatementFile); a generic CSV's columns here */}
      {parsed?.csv && parsed.csv.header.length > 0 && (
        <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6">
          <MappingEditor header={parsed.csv.header} rows={parsed.csv.rows} mapping={parsed.csv.mapping} onChange={remap} t={t} />
        </section>
      )}

      {/* Step 2: review */}
      {parsed && (
        <>
          <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
            <div className="p-4 sm:p-6 pb-3 sm:pb-3">
              <h2 className="text-sm font-semibold">{t('bankImport.reviewTitle')}</h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('bankImport.reviewHint')}</p>
              {invoices.length === 0 && (
                <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 mt-2"><AlertTriangle size={13} /> {t('bankImport.noOpenInvoices')}</p>
              )}
            </div>

            {credits.length === 0 ? (
              <p className="px-4 sm:px-6 pb-4 text-sm text-neutral-500 dark:text-neutral-400">{t('bankImport.noCredits')}</p>
            ) : (
              <>
                {/* Mobile cards */}
                <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800 border-t border-neutral-100 dark:border-neutral-800">
                  {credits.map(r => (
                    <div key={r.transaction.id} className={`px-4 py-3 space-y-2 ${isChecked(r) ? 'bg-blue-50/60 dark:bg-blue-950/20' : ''}`}>
                      <div className="flex items-start gap-3">
                        <label className="h-11 w-11 -ml-3 -my-2 flex items-center justify-center shrink-0 cursor-pointer">{rowCheckbox(r)}</label>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-3">
                            <p className="text-sm font-medium truncate">{r.transaction.counterparty || '—'}</p>
                            <p className="text-sm font-semibold shrink-0">{money(r.transaction.amount, r.transaction.currency)}</p>
                          </div>
                          <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate" title={r.transaction.text}>{r.transaction.text || '—'}</p>
                          <p className="text-xs text-neutral-500 dark:text-neutral-500 mt-0.5">
                            {formatDate(r.transaction.date, lang)}{spesen(r.transaction) && ` · ${spesen(r.transaction)}`}
                          </p>
                        </div>
                      </div>
                      {invoiceSelect(r)}
                      <div className="flex items-start justify-between gap-3">
                        {pill(r)}
                      </div>
                      {skontoLine(r)}
                      {bankFeesLine(r)}
                      {recordedLine(r)}
                      {overpayLine(r)}
                    </div>
                  ))}
                </div>

                {/* Desktop table */}
                <table className="hidden sm:table w-full text-sm">
                  <thead className="border-y border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">
                    <tr>
                      <th className="pl-4 py-3 w-8">
                        <input type="checkbox" className={CHECKBOX_CLS} checked={allChecked} disabled={!bulk.length} aria-label={t('bankImport.selectAll')} onChange={e => toggleAll(e.target.checked)} />
                      </th>
                      <th className="px-3 py-3 text-left font-medium">{t('bankImport.thDate')}</th>
                      <th className="px-3 py-3 text-left font-medium">{t('bankImport.thCounterparty')}</th>
                      <th className="px-3 py-3 text-left font-medium">{t('bankImport.thText')}</th>
                      <th className="px-3 py-3 text-right font-medium">{t('bankImport.thAmount')}</th>
                      <th className="px-3 py-3 text-left font-medium w-64">{t('bankImport.thInvoice')}</th>
                      <th className="px-3 pr-4 py-3 text-left font-medium">{t('bankImport.thConfidence')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
                    {credits.map(r => (
                      <tr key={r.transaction.id} className={isChecked(r) ? 'bg-blue-50/60 dark:bg-blue-950/20' : ''}>
                        <td className="pl-4 py-3 align-top">{rowCheckbox(r)}</td>
                        <td className="px-3 py-3 align-top whitespace-nowrap text-neutral-500 dark:text-neutral-400">{formatDate(r.transaction.date, lang)}</td>
                        <td className="px-3 py-3 align-top max-w-40 truncate" title={r.transaction.counterparty ?? undefined}>{r.transaction.counterparty || '—'}</td>
                        <td className="px-3 py-3 align-top max-w-56 text-neutral-500 dark:text-neutral-400" title={r.transaction.text}>
                          <span className="block truncate">{r.transaction.text || '—'}</span>
                          {spesen(r.transaction) && <span className="block text-xs">{spesen(r.transaction)}</span>}
                        </td>
                        <td className="px-3 py-3 align-top text-right whitespace-nowrap font-medium">{money(r.transaction.amount, r.transaction.currency)}</td>
                        <td className="px-3 py-2.5 align-top space-y-1.5">
                          {invoiceSelect(r)}
                          {skontoLine(r)}
                          {bankFeesLine(r)}
                          {recordedLine(r)}
                          {overpayLine(r)}
                        </td>
                        <td className="px-3 pr-4 py-3 align-top">{pill(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {skipped.length > 0 && (
              <div className="border-t border-neutral-100 dark:border-neutral-800">
                <button
                  type="button"
                  onClick={() => setSkippedOpen(o => !o)}
                  aria-expanded={skippedOpen}
                  className="w-full flex items-center gap-2 px-4 py-3 text-xs text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-left"
                >
                  {skippedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="font-medium">{t('bankImport.skippedTitle')}</span>
                  <span className="truncate">
                    · {skippedSummary.filter(([count]) => count > 0).map(([count, one, other]) => plural(count, one, other)).join(' · ')}
                  </span>
                </button>
                {skippedOpen && (
                  <div className="divide-y divide-neutral-50 dark:divide-neutral-800 text-xs border-t border-neutral-100 dark:border-neutral-800">
                    {skipped.map(r => (
                      <div key={r.transaction.id} className="flex items-center gap-3 px-4 py-2 text-neutral-500 dark:text-neutral-400">
                        <span className="shrink-0 w-20">{formatDate(r.transaction.date, lang)}</span>
                        <span className="min-w-0 flex-1 truncate" title={`${r.transaction.counterparty ?? ''} ${r.transaction.text}`.trim()}>
                          {[r.transaction.counterparty, r.transaction.text].filter(Boolean).join(' · ') || '—'}
                        </span>
                        <span className={`shrink-0 font-medium ${r.transaction.amount < 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{money(r.transaction.amount, r.transaction.currency)}</span>
                        <span className="shrink-0 px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800">{statusLabel(r)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <div className="sticky bottom-[calc(3.5rem_+_env(safe-area-inset-bottom))] md:bottom-0 z-10 -mx-4 sm:mx-0 px-4 py-3 bg-white/95 dark:bg-neutral-900/95 backdrop-blur border-t sm:border sm:rounded-xl border-neutral-200 dark:border-neutral-700 flex items-center justify-between gap-3">
            <p className="text-sm min-w-0 truncate">
              <span className="font-medium">{plural(chosen.length, 'bankImport.selectedOne', 'bankImport.selectedOther')}</span>
              <span className="text-neutral-500 dark:text-neutral-400"> · {money(chosenTotal, currency)}</span>
              {excessTotal > 0.005 && <span className="text-amber-600 dark:text-amber-400"> · {t('bankImport.overpayHint', { amount: money(excessTotal, currency) })}</span>}
            </p>
            <Button type="button" onClick={() => void doImport()} disabled={!chosen.length || busy} className="shrink-0 px-4">
              {busy ? t('bankImport.importing') : t('bankImport.importButton')}
            </Button>
          </div>

          <ConfirmDialog
            open={confirmOverpay}
            title={t('books.fees.importTitle')}
            description={n(
              overpaid.length,
              t('books.fees.importDescOne', { amount: money(excessTotal, currency) }),
              t('books.fees.importDescOther', { count: overpaid.length, amount: money(excessTotal, currency) }),
            )}
            confirmLabel={t('bankImport.importButton')}
            busy={busy}
            onConfirm={() => void doImport(true)}
            onCancel={() => setConfirmOverpay(false)}
          >
            <fieldset className="space-y-2">
              <legend className="sr-only">{t('books.fees.importTitle')}</legend>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input type="radio" name="bank-import-excess" className="mt-1 shrink-0" checked={excessAs === 'fee'} onChange={() => setExcessAs('fee')} />
                <span>
                  {t('books.fees.importAsFee')}
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{t('books.fees.splitFeeHint')}</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input type="radio" name="bank-import-excess" className="mt-1 shrink-0" checked={excessAs === 'payment'} onChange={() => setExcessAs('payment')} />
                <span>{t('books.fees.importAsPayment')}</span>
              </label>
            </fieldset>
          </ConfirmDialog>
        </>
      )}
    </div>
  )
}
