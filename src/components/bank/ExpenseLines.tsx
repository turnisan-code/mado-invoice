'use client'

// The lines booked straight into Bookamat (PR 9a): the statement's debits („Ausgaben“) and the
// credits that pay no invoice („Andere Gutschriften“). Each line as the Analyse made it, with
// what the owner sets on it — the rule among those that fit, the accounts and VAT, the dates,
// split lines, a Beleg —, saved as it changes. The booking each line would make is built and
// checked here with the server's own engine (lib/expenses), so the row shows what is booked.
// Only „Bereit“ lines are ticked on their own; the server checks every line again.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Paperclip, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { createClient } from '@/lib/supabase/client'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-errors'
import { formatDate, formatMoney } from '@/lib/utils/document'
import type { BankLineReview, BankLineSplit } from '@/types'
import type { LineView } from '@/lib/expenses/statement'
import type { LineResult } from '@/lib/expenses/book'
import type { BookamatAccount, BookamatAccounts, MatchedIncomeTransaction, MatchedTransaction } from '@/lib/expenses/types'
import { buildExpenseBookingPayload, buildIncomeBookingPayload, payloadContext } from '@/lib/expenses/booking-payload'
import { blockingProblems, validatePayload, type BookingProblem } from '@/lib/expenses/booking-validation'
import { resolveExpenseDefaults, resolveIncomeDefaults, type AccountLookup } from '@/lib/expenses/row-defaults'
import { linkedTaxAccounts, purchasePool } from '@/lib/expenses/tax-accounts'
import { allowedRates, AT_VAT_RATES } from '@/lib/expenses/vat-origin'
import { payDay } from '@/lib/expenses/booking-dates'
import { isOpenRuleChoice, pickRule } from '@/lib/expenses/rule-match'
import { statementBankAccountId } from '@/lib/expenses/bank-account'
import { setExpenseOwner, type ExpenseOwner } from '@/lib/expenses/owner'

interface Props {
  kind: 'expense' | 'bank_income'
  lines: LineView[]
  accounts: Record<number, BookamatAccounts>
  accountsErrors: Record<number, string>
  owner: ExpenseOwner
  onChanged: () => Promise<void> | void
}

type Row = MatchedTransaction | MatchedIncomeTransaction
type Pill = 'ready' | 'receipt' | 'choice' | 'review' | 'unknown' | 'duplicate' | 'possible' | 'booked' | 'skipped' | 'pending' | 'blocked' | 'failed'

const PILL_CLS: Record<Pill, string> = {
  ready: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  booked: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  receipt: 'text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300',
  choice: 'text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300',
  review: 'text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300',
  possible: 'text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300',
  pending: 'text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300',
  duplicate: 'text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300',
  failed: 'text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300',
  blocked: 'text-neutral-600 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-300',
  unknown: 'text-neutral-600 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-300',
  skipped: 'text-neutral-500 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-400',
}
const CHECKBOX_CLS = 'h-4 w-4 shrink-0 rounded border-neutral-300 dark:border-neutral-600 accent-blue-500 disabled:opacity-40'
const SAVE_DELAY_MS = 600

const lookup = (list?: BookamatAccount[] | null): AccountLookup => {
  const m = new Map((list ?? []).map(a => [a.id, a]))
  return id => m.get(id)
}
const safeName = (name: string) => name.replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(-120) || 'beleg'

// The line as the owner set it: the rule picked, the fields, the split lines
function withReview(v: LineView, review: BankLineReview): Row {
  const base = v.row as Row
  if (v.kind !== 'expense') return { ...base, override: review.override ?? {} }
  const row = base as MatchedTransaction
  const picked = review.rule_id && row.rule_choices?.some(r => r.id === review.rule_id) && row.vendor?.id !== review.rule_id
    ? pickRule(row, review.rule_id, 'owner') : row
  return { ...picked, override: review.override ?? {}, booking_lines: review.lines?.length ? review.lines : undefined }
}

// Saving as the owner types: each line's latest review after a short pause, every pending one at
// once before a booking (the server books what is stored)
function useAutosave(save: (id: string, review: BankLineReview) => Promise<boolean>) {
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const latest = useRef<Record<string, BankLineReview>>({})
  const running = useRef<Record<string, Promise<boolean>>>({})
  const queue = useCallback((id: string, review: BankLineReview) => {
    latest.current[id] = review
    clearTimeout(timers.current[id])
    timers.current[id] = setTimeout(() => {
      delete timers.current[id]
      running.current[id] = save(id, latest.current[id])
    }, SAVE_DELAY_MS)
  }, [save])
  const flush = useCallback(async (): Promise<boolean> => {
    for (const [id, timer] of Object.entries(timers.current)) {
      clearTimeout(timer)
      delete timers.current[id]
      running.current[id] = save(id, latest.current[id])
    }
    const all = await Promise.all(Object.values(running.current))
    running.current = {}
    return all.every(Boolean)
  }, [save])
  useEffect(() => {
    const pending = timers.current
    return () => { for (const timer of Object.values(pending)) clearTimeout(timer) }
  }, [])
  return { queue, flush }
}

export default function ExpenseLines({ kind, lines, accounts, accountsErrors, owner, onChanged }: Props) {
  const { t, lang } = useT()
  const [reviews, setReviews] = useState<Record<string, BankLineReview>>({})
  const [selection, setSelection] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<LineResult[] | null>(null)
  const [saving, setSaving] = useState<Record<string, 'saving' | 'saved' | 'failed'>>({})
  const [forget, setForget] = useState<LineView | null>(null)
  const plural = (count: number, one: DictKey, other: DictKey) => n(count, t(one, { count }), t(other, { count }))
  const money = (amount: number) => formatMoney(amount, 'EUR', lang)

  // The owner as Einstellungen name him: his UID is never a counterparty's (the server does the same)
  setExpenseOwner(owner)

  const reviewOf = useCallback((v: LineView): BankLineReview => reviews[v.line.id] ?? v.line.review ?? {}, [reviews])

  // Each line's booking as it would be posted, and what stops it
  const prepared = useMemo(() => lines.map(v => {
    const review = reviewOf(v)
    const row = withReview(v, review)
    const lists = accounts[v.year] ?? null
    const tx = row.transaction
    const engineKind = v.kind === 'expense' ? 'expense' : 'income'
    const ctx = { ...payloadContext(lists), csvBankId: statementBankAccountId(lists?.bank_accounts, tx.raw?.col0) }
    const ov = (review.override ?? {}) as Record<string, string>
    const payload = v.kind === 'expense'
      ? buildExpenseBookingPayload(row as MatchedTransaction, ov, ctx)
      : buildIncomeBookingPayload(row as MatchedIncomeTransaction, ov, ctx)
    const problems: BookingProblem[] = lists
      ? validatePayload(payload, engineKind, lists, { ...(v.kind === 'expense' ? { expectedTotal: tx.amount } : {}), year: v.year, pay: payDay(tx, engineKind) })
      : [{ message: t('expenses.accountsMissing', { year: v.year, error: accountsErrors[v.year] ?? '' }), blocking: true }]
    const acked = new Set(review.ack_duplicate_ids ?? [])
    const dup = row.duplicate_of && !acked.has(row.duplicate_of.id) ? row.duplicate_of : null
    const refund = v.kind === 'bank_income' ? (row as MatchedIncomeTransaction).refund ?? null : null
    const choice = v.kind === 'expense' && isOpenRuleChoice(row as MatchedTransaction)
    const status = (dup ? (row as { own_status?: string }).own_status : row.status) ?? row.status
    let pill: Pill
    if (v.line.status === 'booked') pill = 'booked'
    else if (v.line.status === 'skipped') pill = 'skipped'
    else if (v.line.bookamat_pending) pill = 'pending'
    else if (v.madoDocument || refund) pill = 'blocked'
    else if (row.duplicate_check_failed) pill = 'failed'
    else if (dup) pill = dup.certain ? 'duplicate' : 'possible'
    else if (choice) pill = 'choice'
    else if (status === 'ready') pill = 'ready'
    else if (status === 'no_invoice' || status === 'missing_invoice') pill = 'receipt'
    else if (status === 'needs_review') pill = 'review'
    else pill = 'unknown'
    const blocking = blockingProblems(problems).length > 0
    const bookable = v.line.status === 'open' && !v.line.bookamat_pending && !v.madoDocument && !refund && !row.duplicate_check_failed && !dup && !choice && !blocking
    return { v, review, row, lists, payload, problems, dup, refund, choice, pill, bookable, ticked: pill === 'ready' && bookable }
  }), [lines, reviewOf, accounts, accountsErrors, t])

  const isChecked = (p: (typeof prepared)[number]) => p.bookable && (selection[p.v.line.id] ?? p.ticked)
  const chosen = prepared.filter(isChecked)
  const bulk = prepared.filter(p => p.bookable && p.pill === 'ready')
  const allChecked = bulk.length > 0 && bulk.every(isChecked)

  // ─── Saving what the owner sets ────────────────────────────────────────────

  const save = useCallback((id: string, review: BankLineReview): Promise<boolean> => {
    setSaving(s => ({ ...s, [id]: 'saving' }))
    const run = fetch(`/api/bank-lines/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review }) })
      .then(async res => {
        if (!res.ok) throw new Error(apiErrorMessage(t, await res.json().catch(() => ({}))))
        setSaving(s => ({ ...s, [id]: 'saved' }))
        return true
      })
      .catch((err: unknown) => {
        setSaving(s => ({ ...s, [id]: 'failed' }))
        toast.error(t('expenses.saveFailed', { error: err instanceof Error ? err.message : String(err) }))
        return false
      })
    return run
  }, [t])
  const autosave = useAutosave(save)

  const setReview = (id: string, review: BankLineReview) => {
    setReviews(r => ({ ...r, [id]: review }))
    autosave.queue(id, review)
  }
  // Before a booking: every change saved (the server books what is stored)
  const flush = autosave.flush

  const setOverride = (p: (typeof prepared)[number], key: string, value: string | null) => {
    const override = { ...(p.review.override ?? {}) }
    if (value === null) delete override[key]
    else override[key] = value
    setReview(p.v.line.id, { ...p.review, override })
  }

  async function post(path: string, body?: unknown): Promise<boolean> {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null)
    if (!res?.ok) {
      toast.error(res ? apiErrorMessage(t, await res.json().catch(() => ({}))) : t('messages.network'))
      return false
    }
    return true
  }

  async function patch(id: string, body: unknown): Promise<boolean> {
    const res = await fetch(`/api/bank-lines/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    if (!res?.ok) {
      toast.error(res ? apiErrorMessage(t, await res.json().catch(() => ({}))) : t('messages.network'))
      return false
    }
    return true
  }

  async function pickRuleFor(p: (typeof prepared)[number], ruleId: string) {
    await flush()
    const review = { ...p.review, rule_id: ruleId }
    setReviews(r => ({ ...r, [p.v.line.id]: review }))
    if (await patch(p.v.line.id, { review })) await onChanged()
  }

  async function setStatus(p: (typeof prepared)[number], status: 'open' | 'skipped') {
    await flush()
    if (await patch(p.v.line.id, { status })) await onChanged()
  }

  async function ackDuplicate(p: (typeof prepared)[number]) {
    if (!p.dup) return
    setReview(p.v.line.id, { ...p.review, ack_duplicate_ids: [...new Set([...(p.review.ack_duplicate_ids ?? []), p.dup.id])] })
    setSelection(s => ({ ...s, [p.v.line.id]: true }))
  }

  async function uploadReceipt(p: (typeof prepared)[number], file: File) {
    if (file.size > 15 * 1024 * 1024) { toast.error(t('expenses.receiptTooLarge')); return }
    setBusy(true)
    const path = `${p.v.line.id}/${safeName(file.name)}`
    const { error } = await createClient().storage.from('receipts').upload(path, file, { upsert: true, contentType: file.type || undefined })
    if (error) { setBusy(false); toast.error(t('expenses.receiptFailed', { error: error.message })); return }
    const ok = await patch(p.v.line.id, { receipt: { path, name: file.name } })
    setBusy(false)
    if (ok) await onChanged()
  }

  async function removeReceipt(p: (typeof prepared)[number]) {
    if (!p.v.line.receipt_path) return
    setBusy(true)
    await createClient().storage.from('receipts').remove([p.v.line.receipt_path])
    const ok = await patch(p.v.line.id, { receipt: null })
    setBusy(false)
    if (ok) await onChanged()
  }

  async function book() {
    const ids = chosen.map(p => p.v.line.id)
    if (!ids.length) return
    setBusy(true)
    if (!await flush()) { setBusy(false); return }
    const res = await fetch('/api/bank-lines/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).catch(() => null)
    setBusy(false)
    if (!res?.ok) {
      toast.error(t('expenses.bookFailed', { error: res ? apiErrorMessage(t, await res.json().catch(() => ({}))) : t('messages.network') }))
      return
    }
    const body = await res.json().catch(() => null) as { results?: LineResult[] } | null
    setResults(body?.results ?? [])
    setSelection({})
    await onChanged()
  }

  async function forgetBooking(v: LineView) {
    setBusy(true)
    const ok = await post(`/api/bank-lines/${v.line.id}/forget`)
    setBusy(false)
    setForget(null)
    if (ok) await onChanged()
  }

  async function discardAttempt(v: LineView) {
    setBusy(true)
    const ok = await post(`/api/bank-lines/${v.line.id}/discard`)
    setBusy(false)
    if (ok) await onChanged()
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  const lineById = new Map(lines.map(v => [v.line.id, v]))
  const pillLabel = (pill: Pill): string => t(`expenses.pill.${pill}`)

  function accountSelect(value: number, list: BookamatAccount[], onChange: (id: string) => void, label: string, locked = false) {
    const known = list.some(a => a.id === value)
    return (
      <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
        <span className="block font-medium">{label}</span>
        <Select value={value ? String(value) : ''} disabled={locked} onChange={e => onChange(e.target.value)}>
          <option value="">{t('expenses.choose')}</option>
          {!known && value > 0 && <option value={value}>#{value}</option>}
          {list.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      </label>
    )
  }

  function textField(label: string, value: string, onChange: (v: string) => void, type: 'text' | 'date' = 'text', placeholder?: string) {
    return (
      <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
        <span className="block font-medium">{label}</span>
        <Input type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
      </label>
    )
  }

  function percentField(label: string, value: number, locked: number | null, onChange: (v: string) => void) {
    return (
      <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
        <span className="block font-medium">{label}</span>
        {locked !== null
          ? <p className="text-sm text-neutral-700 dark:text-neutral-200 py-2">{t('expenses.locked', { value: locked })}</p>
          : <Input type="number" min={0} max={100} step="0.01" value={String(value)} onChange={e => onChange(e.target.value)} />}
      </label>
    )
  }

  function rateSelect(value: number, rates: number[], onChange: (v: string) => void, label: string) {
    const list = [...new Set([...rates, value])].sort((a, b) => b - a)
    return (
      <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
        <span className="block font-medium">{label}</span>
        <Select value={String(value)} onChange={e => onChange(e.target.value)}>
          {list.map(r => <option key={r} value={r}>{r} %</option>)}
        </Select>
      </label>
    )
  }

  function editor(p: (typeof prepared)[number]) {
    const { v, review, row, lists, payload } = p
    const ov = (review.override ?? {}) as Record<string, string>
    const set = (key: string) => (value: string) => setOverride(p, key, value)
    const locked = v.line.status !== 'open' || !!v.line.bookamat_pending
    const rates = (id: number) => allowedRates(lists?.purchasetax_accounts?.find(a => a.id === id)) ?? [...AT_VAT_RATES, 0]
    const fields = v.kind === 'expense' ? (() => {
      const costLookup = lookup(lists?.cost_accounts)
      const d = resolveExpenseDefaults(row as MatchedTransaction, ov, id => lists?.cost_accounts?.find(a => a.id === id)?.name, 0, costLookup)
      const cost = lists?.cost_accounts?.find(a => a.id === d.costAccountId)
      const pool = purchasePool(lists?.purchasetax_accounts, cost?.purchasetaxaccounts)
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {accountSelect(d.costAccountId, lists?.cost_accounts ?? [], set('cost_account_id'), t('expenses.costAccount'), locked)}
          {accountSelect(d.purchasetaxAccountId, pool, set('purchasetax_account_id'), t('expenses.taxAccount'), locked)}
          {rateSelect(d.taxPercent, rates(d.purchasetaxAccountId), set('tax_percent'), t('expenses.rate'))}
          {percentField(t('expenses.baAmount'), d.deductAmountPercent, d.locks.amount, set('deductibility_amount_percent'))}
          {percentField(t('expenses.baTax'), d.deductTaxPercent, d.locks.tax, set('deductibility_tax_percent'))}
          {textField(t('expenses.vatin'), ov.vatin ?? d.vatin, set('vatin'))}
          {textField(t('expenses.country'), ov.country ?? d.country, set('country'), 'text', 'AT')}
        </div>
      )
    })() : (() => {
      const revLookup = lookup(lists?.revenue_accounts)
      const d = resolveIncomeDefaults(row as MatchedIncomeTransaction, ov, 0, revLookup)
      const revenue = lists?.revenue_accounts?.find(a => a.id === d.revenueAccountId)
      const pool = linkedTaxAccounts(lists?.purchasetax_accounts, revenue?.purchasetaxaccounts, 'sales')
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {accountSelect(d.revenueAccountId, lists?.revenue_accounts ?? [], set('revenue_account_id'), t('expenses.revenueAccount'), locked)}
          {accountSelect(d.vatAccountId, pool, set('vat_account_id'), t('expenses.vatAccount'), locked)}
          {rateSelect(d.vatPercent, rates(d.vatAccountId), set('vat_percent'), t('expenses.rate'))}
          {textField(t('expenses.vatin'), ov.vatin ?? d.vatin, set('vatin'))}
          {textField(t('expenses.country'), ov.country ?? d.country, set('country'), 'text', 'AT')}
        </div>
      )
    })()

    const splits = review.lines ?? []
    const setSplits = (next: BankLineSplit[]) => setReview(v.line.id, { ...review, lines: next })
    const total = Math.abs(Number(v.line.amount))

    return (
      <div className="space-y-4 px-4 sm:px-6 pb-5 pt-1">
        {p.choice && (
          <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 px-3 py-2 space-y-2">
            <p className="text-xs font-medium text-blue-800 dark:text-blue-300">{t('expenses.choiceTitle')}</p>
            <div className="flex flex-wrap gap-2">
              {((row as MatchedTransaction).rule_choices ?? []).map(r => (
                <Button key={r.id} type="button" variant="outline" disabled={busy || locked} onClick={() => void pickRuleFor(p, r.id)}>{r.name}</Button>
              ))}
            </div>
          </div>
        )}
        {fields}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {textField(t('expenses.title'), ov.title ?? payload.title, set('title'))}
          {textField(t('expenses.bookingDate'), ov.date ?? payload.date, set('date'), 'date')}
          {textField(t('expenses.invoiceDate'), ov.date_invoice ?? payload.date_invoice ?? '', set('date_invoice'), 'date')}
          {textField(t('expenses.deliveryDate'), ov.date_delivery ?? payload.date_delivery ?? '', set('date_delivery'), 'date')}
        </div>
        {textField(t('expenses.description'), ov.description ?? payload.description, set('description'))}

        {v.kind === 'expense' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('expenses.splitTitle')}</p>
              <div className="flex gap-2">
                {splits.length > 0 && <Button type="button" variant="ghost" size="sm" onClick={() => setSplits([])}>{t('expenses.splitRemove')}</Button>}
                <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => setSplits(splits.length
                  ? [...splits, { label: '', amount_gross: 0, vat_percent: 0 }]
                  : [{ label: '', amount_gross: total, vat_percent: Number(payload.amounts[0]?.tax_percent ?? 20) }, { label: '', amount_gross: 0, vat_percent: 0 }])}>
                  <Plus size={14} /> {t('expenses.splitAdd')}
                </Button>
              </div>
            </div>
            {splits.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_7rem_6rem_2.5rem] gap-2 items-end">
                {textField(t('expenses.splitLabel'), s.label, value => setSplits(splits.map((x, k) => (k === i ? { ...x, label: value } : x))))}
                <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
                  <span className="block font-medium">{t('expenses.splitAmount')}</span>
                  <Input type="number" step="0.01" value={String(s.amount_gross)} onChange={e => setSplits(splits.map((x, k) => (k === i ? { ...x, amount_gross: Number(e.target.value) || 0 } : x)))} />
                </label>
                {rateSelect(s.vat_percent, [...AT_VAT_RATES, 0], value => setSplits(splits.map((x, k) => (k === i ? { ...x, vat_percent: Number(value) } : x))), t('expenses.rate'))}
                <button type="button" aria-label={t('common.remove')} onClick={() => setSplits(splits.filter((_, k) => k !== i))} className="h-9 w-9 flex items-center justify-center rounded-md text-neutral-500 hover:text-red-600">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {v.line.receipt_path ? (
            <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md bg-neutral-100 dark:bg-neutral-800">
              <Paperclip size={12} /> {v.line.receipt_name ?? t('expenses.receipt')}
              {!locked && <button type="button" aria-label={t('expenses.receiptRemove')} onClick={() => void removeReceipt(p)} className="ml-1 text-neutral-500 hover:text-red-600"><X size={12} /></button>}
            </span>
          ) : !locked && (
            <label className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800">
              <Paperclip size={12} /> {t('expenses.receiptUpload')}
              <input type="file" accept=".pdf,.jpg,.jpeg,.png,.gif,application/pdf,image/*" className="sr-only" onChange={e => { const f = e.target.files?.[0]; if (f) void uploadReceipt(p, f); e.target.value = '' }} />
            </label>
          )}
          {v.line.status === 'open' && !v.line.bookamat_pending && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void setStatus(p, 'skipped')}>{t('expenses.skip')}</Button>}
          {v.line.status === 'skipped' && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void setStatus(p, 'open')}>{t('expenses.reopen')}</Button>}
          {p.dup && v.line.status === 'open' && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void ackDuplicate(p)}>{t('expenses.bookAnyway')}</Button>}
          {v.line.status === 'booked' && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setForget(v)}>{t('expenses.forget')}</Button>}
          {v.line.bookamat_pending && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void discardAttempt(v)}>{t('expenses.discard')}</Button>}
          {saving[v.line.id] && <span className="text-[11px] text-neutral-400 ml-auto">{t(`expenses.save.${saving[v.line.id]}`)}</span>}
        </div>
      </div>
    )
  }

  function notes(p: (typeof prepared)[number]) {
    const { v, row, dup, problems, refund } = p
    const out: { text: string; tone: 'warn' | 'error' | 'info' }[] = []
    if (v.madoDocument) out.push({ text: v.madoDocument, tone: 'info' })
    if (refund) out.push({ text: row.match_note ?? refund, tone: 'info' })
    else if (row.match_note) out.push({ text: row.match_note, tone: 'info' })
    if (row.duplicate_check_failed) out.push({ text: t('expenses.checkFailed', { error: row.duplicate_check_failed }), tone: 'error' })
    if (dup) out.push({ text: t(dup.certain ? 'expenses.duplicateCertain' : 'expenses.duplicatePossible', { title: dup.title, date: formatDate(dup.date, lang), id: dup.id }), tone: dup.certain ? 'error' : 'warn' })
    if (v.line.bookamat_pending) out.push({ text: t('expenses.pendingHint'), tone: 'warn' })
    if (v.line.status === 'open') for (const pr of problems) out.push({ text: pr.message, tone: pr.blocking ? 'error' : 'warn' })
    return out
  }

  if (!lines.length) {
    return <p className="text-sm text-neutral-500 dark:text-neutral-400 px-4 sm:px-6 py-4">{t(kind === 'expense' ? 'expenses.noDebits' : 'expenses.noOtherCredits')}</p>
  }

  return (
    <div className="space-y-3">
      {Object.entries(accountsErrors).map(([year, error]) => (
        <p key={year} className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 px-4 sm:px-6"><AlertTriangle size={13} /> {t('expenses.accountsMissing', { year, error })}</p>
      ))}

      <div className="divide-y divide-neutral-100 dark:divide-neutral-800 border-y border-neutral-100 dark:border-neutral-800">
        <div className="flex items-center gap-3 px-4 sm:px-6 py-2 bg-neutral-50 dark:bg-neutral-800 text-xs text-neutral-500 dark:text-neutral-400">
          <input type="checkbox" className={CHECKBOX_CLS} checked={allChecked} disabled={!bulk.length} aria-label={t('expenses.selectAll')}
            onChange={e => setSelection(s => {
              const next = { ...s }
              for (const p of e.target.checked ? bulk : prepared) next[p.v.line.id] = e.target.checked
              return next
            })} />
          <span>{t('expenses.selectAllHint')}</span>
        </div>
        {prepared.map(p => {
          const { v, payload } = p
          const expanded = open === v.line.id
          const tx = p.row.transaction
          return (
            <div key={v.line.id} className={isChecked(p) ? 'bg-blue-50/60 dark:bg-blue-950/20' : ''}>
              <div className="flex items-start gap-3 px-4 sm:px-6 py-3">
                <input type="checkbox" className={`${CHECKBOX_CLS} mt-1`} checked={isChecked(p)} disabled={!p.bookable || busy}
                  aria-label={t('expenses.select')} onChange={e => setSelection(s => ({ ...s, [v.line.id]: e.target.checked }))} />
                <button type="button" onClick={() => setOpen(expanded ? null : v.line.id)} className="flex-1 min-w-0 text-left">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-medium truncate flex items-center gap-1">
                      {expanded ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
                      {payload.title || tx.counterparty || '—'}
                    </p>
                    <p className="text-sm font-semibold shrink-0">{money(Number(v.line.amount))}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
                    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${PILL_CLS[p.pill]}`}>
                      {p.pill === 'booked' && v.booking ? t('expenses.pill.bookedAs', { id: v.booking.booking_id }) : pillLabel(p.pill)}
                    </span>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
                      {formatDate(v.line.booked_on, lang)} · {tx.counterparty || '—'}{v.line.fee ? ` · ${t('expenses.fee', { amount: money(Number(v.line.fee)) })}` : ''}
                    </span>
                    {v.line.receipt_path && <Paperclip size={12} className="text-neutral-400" aria-label={t('expenses.receipt')} />}
                  </div>
                  {notes(p).map((note, i) => (
                    <p key={i} className={`text-[11px] leading-tight mt-1 ${note.tone === 'error' ? 'text-red-600 dark:text-red-400' : note.tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-neutral-500 dark:text-neutral-400'}`}>{note.text}</p>
                  ))}
                </button>
              </div>
              {expanded && editor(p)}
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 px-4 sm:px-6 pb-4">
        <Button type="button" disabled={!chosen.length || busy} onClick={() => void book()} className="px-4">
          {busy ? t('expenses.booking') : plural(chosen.length, 'expenses.bookOne', 'expenses.bookOther')}
        </Button>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('expenses.bookHint')}</p>
      </div>

      {results && results.length > 0 && (
        <div className="mx-4 sm:mx-6 mb-4 rounded-md border border-neutral-200 dark:border-neutral-700 px-3 py-2 space-y-1">
          <p className="text-xs font-medium flex items-center gap-1.5"><CheckCircle2 size={13} className="text-green-600" /> {t('expenses.resultTitle')}</p>
          <ul className="text-xs space-y-1">
            {results.map(r => {
              const v = lineById.get(r.id)
              const label = v ? `${formatDate(v.line.booked_on, lang)} · ${money(Number(v.line.amount))} · ${v.line.counterparty || '—'}` : r.id
              return (
                <li key={r.id}>
                  {label}{' — '}
                  {r.status === 'booked' && <span className="text-green-700 dark:text-green-400">{t('expenses.resultBooked', { id: r.bookingId })}{r.corrections.length ? ` · ${r.corrections.join(' · ')}` : ''}{r.receiptError ? ` · ${r.receiptError}` : ''}</span>}
                  {r.status === 'duplicate' && <span className="text-amber-700 dark:text-amber-400">{t('expenses.duplicateCertain', { title: r.existing.title, date: formatDate(r.existing.date, lang), id: r.existing.id })}</span>}
                  {r.status === 'skipped' && <span className="text-neutral-500">{r.reason}</span>}
                  {r.status === 'error' && <span className="text-red-600 dark:text-red-400 whitespace-pre-line">{r.error}</span>}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={!!forget}
        title={t('expenses.forgetTitle')}
        description={forget?.booking ? t('expenses.forgetText', { id: forget.booking.booking_id }) : ''}
        confirmLabel={t('expenses.forget')}
        destructive
        busy={busy}
        onConfirm={() => { if (forget) void forgetBooking(forget) }}
        onCancel={() => setForget(null)}
      />
    </div>
  )
}
