'use client'

// The lines booked straight into Bookamat (PR 9a): the statement's debits („Ausgaben“) and the
// credits that pay no invoice („Andere Gutschriften“). Each line as the Analyse made it, with
// what the owner sets on it — the rule among those that fit, the accounts and VAT, the dates,
// split lines, a Beleg —, saved as it changes. The booking each line would make is built and
// checked here with the server's own engine (lib/expenses), and its fingerprint goes with the
// line when it is booked: the server books it only as shown. Only „Bereit“ lines are ticked on
// their own; the server checks every line again. A debit's receipt is searched in Gmail (PR 9b):
// on „In Gmail suchen“, and by itself for the lines from the switch-over date on (decision D11);
// what the search found and did not attach is listed with „Vorschau“ and „Anhängen“.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Eye, Loader2, Mail, Paperclip, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { createClient } from '@/lib/supabase/client'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey, type TFn } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-errors'
import { formatDate, formatMoney } from '@/lib/utils/document'
import type { BankLineReview, BankLineSplit } from '@/types'
import type { GmailCandidate } from '@/lib/expenses/types'
import { bankInvoice, gmailAttachable, gmailCandidateLine, gmailPreviewable } from '@/lib/expenses/receipt-match'
import type { LineView } from '@/lib/expenses/statement'
import type { LineResult } from '@/lib/expenses/book'
import type { BookamatAccount, BookamatAccounts, MatchedIncomeTransaction, MatchedTransaction } from '@/lib/expenses/types'
import { buildExpenseBookingPayload, buildIncomeBookingPayload, payloadContext } from '@/lib/expenses/booking-payload'
import { blockingProblems, validatePayload, type BookingProblem } from '@/lib/expenses/booking-validation'
import { resolveExpenseDefaults, resolveIncomeDefaults, type AccountLookup } from '@/lib/expenses/row-defaults'
import { linkedTaxAccounts, purchasePool } from '@/lib/expenses/tax-accounts'
import { allowedRates, AT_VAT_RATES } from '@/lib/expenses/vat-origin'
import { bookingDateOf, payDay } from '@/lib/expenses/booking-dates'
import { isOpenRuleChoice, ownerSetRuleFields, pickRule } from '@/lib/expenses/rule-match'
import { statementBankAccountId } from '@/lib/expenses/bank-account'
import { payloadFingerprint } from '@/lib/expenses/fingerprint'
import { setExpenseOwner, type ExpenseOwner } from '@/lib/expenses/owner'
import { parseReview } from '@/lib/expenses/review'

interface Props {
  kind: 'expense' | 'bank_income'
  lines: LineView[]
  accounts: Record<number, BookamatAccounts>
  accountsErrors: Record<number, string>
  owner: ExpenseOwner
  // A note per line key the page knows (a credit the „Einnahmen“ tab suggests for an invoice)
  hints?: Record<string, string>
  // Reads the lines again; resolves once they are there
  onChanged: () => Promise<void>
  // Debits only (PR 9b): whether Mado may read Gmail (gmail.readonly granted), whether Claude can
  // read what it finds (ANTHROPIC_API_KEY), and the switch-over date from which it searches by itself
  gmail?: { read: boolean; reader: boolean; switchFrom: string | null }
}

// Searches running at a time (each one line's request, up to 60 s)
const SEARCHES_AT_ONCE = 2

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
// Lines per booking request: each request stays well inside the server's time
const BOOK_CHUNK = 15
// Codes the app words itself; the expense routes' own refusals come worded in `error`
const GENERIC_CODES = new Set(['invalid_request', 'invalid_json', 'unauthorized', 'mfa_required', 'settings_missing', 'database', 'not_found', 'server_error', 'invalid_status'])

const lookup = (list?: BookamatAccount[] | null): AccountLookup => {
  const m = new Map((list ?? []).map(a => [a.id, a]))
  return id => m.get(id)
}
const safeName = (name: string) => name.replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(-120) || 'beleg'

async function failText(t: TFn, res: Response | null): Promise<string> {
  if (!res) return t('messages.network')
  const body = await res.json().catch(() => ({})) as { error?: unknown; code?: unknown }
  const code = typeof body.code === 'string' ? body.code : ''
  if (typeof body.error === 'string' && body.error && !GENERIC_CODES.has(code) && !/^MI0\d\d$/.test(code)) return body.error
  return apiErrorMessage(t, body)
}

// The line as the owner set it: the rule picked, the fields, the split lines
function withReview(v: LineView, review: BankLineReview): Row {
  const base = v.row as Row
  if (v.kind !== 'expense') return { ...base, override: review.override ?? {} }
  const row = base as MatchedTransaction
  const picked = review.rule_id && row.rule_choices?.some(r => r.id === review.rule_id) && row.vendor?.id !== review.rule_id
    ? pickRule(row, review.rule_id, 'owner') : row
  return { ...picked, override: review.override ?? {}, booking_lines: review.lines?.length ? review.lines : undefined }
}

// Saving as the owner types: each line's latest review after a short pause, one save after the
// other per line (a later one never overtaken by an earlier); before a booking every line whose
// latest review is not saved yet is sent again, and the booking waits for all of them. What is
// not saved when the list goes away is sent on its way out.
function useAutosave(save: (id: string, review: BankLineReview) => Promise<boolean>) {
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const latest = useRef<Record<string, BankLineReview>>({})
  const version = useRef<Record<string, number>>({})
  const saved = useRef<Record<string, number>>({})
  const chain = useRef<Record<string, Promise<boolean>>>({})

  const run = useCallback((id: string): Promise<boolean> => {
    const v = version.current[id] ?? 0
    const next = (chain.current[id] ?? Promise.resolve(true)).then(() => save(id, latest.current[id])).then(ok => {
      if (ok) saved.current[id] = Math.max(saved.current[id] ?? 0, v)
      return ok
    })
    chain.current[id] = next
    return next
  }, [save])

  const queue = useCallback((id: string, review: BankLineReview) => {
    latest.current[id] = review
    version.current[id] = (version.current[id] ?? 0) + 1
    clearTimeout(timers.current[id])
    timers.current[id] = setTimeout(() => { delete timers.current[id]; void run(id) }, SAVE_DELAY_MS)
  }, [run])

  // The given lines' changes saved now: the ids whose latest change could not be saved
  const flush = useCallback(async (ids: readonly string[]): Promise<string[]> => {
    for (const id of ids) {
      if (!timers.current[id]) continue
      clearTimeout(timers.current[id])
      delete timers.current[id]
    }
    const dirty = ids.filter(id => (saved.current[id] ?? 0) < (version.current[id] ?? 0))
    await Promise.all(dirty.map(run))
    return ids.filter(id => (saved.current[id] ?? 0) < (version.current[id] ?? 0))
  }, [run])

  useEffect(() => {
    const pending = timers.current
    const versions = version.current
    const done = saved.current
    const reviews = latest.current
    return () => {
      for (const timer of Object.values(pending)) clearTimeout(timer)
      for (const id of Object.keys(versions)) {
        if ((done[id] ?? 0) >= (versions[id] ?? 0)) continue
        void fetch(`/api/bank-lines/${id}`, { method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review: reviews[id] }) }).catch(() => {})
      }
    }
  }, [])

  return { queue, flush }
}

export default function ExpenseLines({ kind, lines, accounts, accountsErrors, owner, hints = {}, onChanged, gmail }: Props) {
  const { t, lang } = useT()
  const [reviews, setReviews] = useState<Record<string, BankLineReview>>({})
  const [selection, setSelection] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<{ items: LineResult[]; labels: Record<string, string> } | null>(null)
  const [saving, setSaving] = useState<Record<string, 'saving' | 'saved' | 'failed'>>({})
  const [forget, setForget] = useState<LineView | null>(null)
  const [forceDiscard, setForceDiscard] = useState<LineView | null>(null)
  // The lines whose Gmail search is running; Gmail found unreadable (a grant without gmail.readonly)
  const [searching, setSearching] = useState<Record<string, boolean>>({})
  const [gmailBlocked, setGmailBlocked] = useState(false)
  const autoTried = useRef(new Set<string>())
  const plural = (count: number, one: DictKey, other: DictKey) => n(count, t(one, { count }), t(other, { count }))
  const money = (amount: number) => formatMoney(amount, 'EUR', lang)

  // The owner's details from Einstellungen: the owner's UID is never a counterparty's (the server
  // does the same with the same settings)
  setExpenseOwner(owner)

  const reviewOf = useCallback((v: LineView): BankLineReview => reviews[v.line.id] ?? v.line.review ?? {}, [reviews])

  // Each line's booking as it would be posted, and what stops it
  const prepared = useMemo(() => lines.map(v => {
    const typed = reviewOf(v)
    // What the server will store of it: the preview (and its fingerprint) is built from that; an
    // edit it would refuse is said on the line and keeps the line from being booked
    const stored = parseReview(typed)
    const invalid = !stored
    const review = stored ?? typed
    const row = withReview(v, review)
    const tx = row.transaction
    const engineKind = v.kind === 'expense' ? 'expense' : 'income'
    const ov = (review.override ?? {}) as Record<string, string>
    // The year of the Buchungsdatum as the owner set it: its own accounts
    const year = Number(bookingDateOf(tx, ov, engineKind).slice(0, 4)) || v.year
    const lists = accounts[year] ?? null
    const ctx = { ...payloadContext(lists), csvBankId: statementBankAccountId(lists?.bank_accounts, tx.raw?.col0) }
    const payload = v.kind === 'expense'
      ? buildExpenseBookingPayload(row as MatchedTransaction, ov, ctx)
      : buildIncomeBookingPayload(row as MatchedIncomeTransaction, ov, ctx)
    const problems: BookingProblem[] = lists
      ? validatePayload(payload, engineKind, lists, { ...(v.kind === 'expense' ? { expectedTotal: tx.amount } : {}), year, pay: payDay(tx, engineKind) })
      : [{ message: accountsErrors[year] ? t('expenses.accountsMissing', { year, error: accountsErrors[year] }) : t('expenses.yearLoading', { year }), blocking: true }]
    const acked = new Set(review.ack_duplicate_ids ?? [])
    const dup = row.duplicate_of && !acked.has(row.duplicate_of.id) ? row.duplicate_of : null
    const refund = v.kind === 'bank_income' ? (row as MatchedIncomeTransaction).refund ?? null : null
    const choice = v.kind === 'expense' && isOpenRuleChoice(row as MatchedTransaction) && !ownerSetRuleFields(ov)
    const status = (row.duplicate_of ? (row as { own_status?: string }).own_status : row.status) ?? row.status
    const pendingLine = !!v.line.bookamat_pending
    let pill: Pill
    if (v.line.status === 'booked') pill = 'booked'
    else if (v.line.status === 'skipped') pill = 'skipped'
    else if (pendingLine) pill = 'pending'
    else if (v.madoDocument || refund || v.gate) pill = 'blocked'
    else if (row.duplicate_check_failed) pill = 'failed'
    else if (dup) pill = dup.certain ? 'duplicate' : 'possible'
    else if (choice) pill = 'choice'
    else if (status === 'ready') pill = 'ready'
    else if (status === 'no_invoice' || status === 'missing_invoice') pill = 'receipt'
    else if (status === 'needs_review') pill = 'review'
    else pill = 'unknown'
    const blocking = blockingProblems(problems).length > 0
    // A line with an open attempt can be booked again whatever it shows now: the server settles
    // the attempt before anything else
    const bookable = v.line.status === 'open'
      && (pendingLine || (!v.madoDocument && !refund && !v.gate && !invalid && !row.duplicate_check_failed && !dup && !choice && !blocking))
    return { v, typed, review, row, year, lists, payload, problems, dup, refund, choice, pill, bookable, pendingLine, invalid, ticked: pill === 'ready' && bookable }
  }), [lines, reviewOf, accounts, accountsErrors, t])

  type Prepared = (typeof prepared)[number]
  const isChecked = (p: Prepared) => p.bookable && (selection[p.v.line.id] ?? p.ticked)
  const chosen = prepared.filter(isChecked)
  const bulk = prepared.filter(p => p.bookable && p.pill === 'ready')
  const allChecked = bulk.length > 0 && bulk.every(isChecked)

  // ─── Saving what the owner sets ────────────────────────────────────────────

  const save = useCallback(async (id: string, review: BankLineReview): Promise<boolean> => {
    setSaving(s => ({ ...s, [id]: 'saving' }))
    const res = await fetch(`/api/bank-lines/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review }) }).catch(() => null)
    if (res?.ok) {
      setSaving(s => ({ ...s, [id]: 'saved' }))
      return true
    }
    setSaving(s => ({ ...s, [id]: 'failed' }))
    toast.error(t('expenses.saveFailed', { error: await failText(t, res) }))
    return false
  }, [t])
  const autosave = useAutosave(save)

  const setReview = (id: string, review: BankLineReview) => {
    setReviews(r => ({ ...r, [id]: review }))
    const stored = parseReview(review)
    if (stored) autosave.queue(id, stored)
  }

  const setOverride = (p: Prepared, key: string, value: string | null) => {
    const override = { ...(p.typed.override ?? {}) }
    if (value === null) delete override[key]
    else override[key] = value
    setReview(p.v.line.id, { ...p.typed, override })
    // A Buchungsdatum in another year: the line is analysed again with that year's rules and
    // accounts
    if (key === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && Number(value!.slice(0, 4)) !== p.year) {
      void autosave.flush([p.v.line.id]).then(left => (left.length ? undefined : onChanged()))
    }
  }

  async function post(path: string, body?: unknown): Promise<boolean> {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null)
    if (res?.ok) return true
    toast.error(await failText(t, res))
    return false
  }

  async function patch(id: string, body: unknown): Promise<boolean> {
    const res = await fetch(`/api/bank-lines/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    if (res?.ok) return true
    toast.error(await failText(t, res))
    return false
  }

  // The lines acted on saved first; a change that cannot be saved stops what was asked, and the
  // line is named
  async function saved(ids: readonly string[]): Promise<boolean> {
    const invalid = prepared.filter(p => ids.includes(p.v.line.id) && p.invalid)
    const left = await autosave.flush(ids.filter(id => !invalid.some(p => p.v.line.id === id)))
    const names = [...invalid.map(p => p.v.line.id), ...left].map(id => {
      const p = prepared.find(x => x.v.line.id === id)
      return p ? `„${p.payload.title || p.row.transaction.counterparty || '—'}“` : id
    })
    if (!names.length) return true
    toast.error(t('expenses.unsavedLines', { lines: names.join(', ') }))
    return false
  }

  async function pickRuleFor(p: Prepared, ruleId: string) {
    setBusy(true)
    if (await saved([p.v.line.id])) {
      const review = { ...p.review, rule_id: ruleId }
      setReviews(r => ({ ...r, [p.v.line.id]: review }))
      if (await patch(p.v.line.id, { review })) await onChanged()
    }
    setBusy(false)
  }

  async function setStatus(p: Prepared, status: 'open' | 'skipped') {
    setBusy(true)
    if (await saved([p.v.line.id]) && await patch(p.v.line.id, { status })) await onChanged()
    setBusy(false)
  }

  function ackDuplicate(lineId: string, bookingId: number) {
    const v = lines.find(l => l.line.id === lineId)
    if (!v) return
    const review = reviewOf(v)
    setReview(lineId, { ...review, ack_duplicate_ids: [...new Set([...(review.ack_duplicate_ids ?? []), bookingId])] })
    setSelection(s => ({ ...s, [lineId]: true }))
  }

  async function uploadReceipt(p: Prepared, file: File) {
    if (file.size > 15 * 1024 * 1024) { toast.error(t('expenses.receiptTooLarge')); return }
    setBusy(true)
    const path = `${p.v.line.id}/${safeName(file.name)}`
    const { error } = await createClient().storage.from('receipts').upload(path, file, { upsert: true, contentType: file.type || undefined })
    if (error) toast.error(t('expenses.receiptFailed', { error: error.message }))
    else if (await saved([p.v.line.id]) && await patch(p.v.line.id, { receipt: { path, name: file.name } })) await onChanged()
    setBusy(false)
  }

  async function removeReceipt(p: Prepared) {
    if (!p.v.line.receipt_path) return
    setBusy(true)
    if (await saved([p.v.line.id]) && await patch(p.v.line.id, { receipt: null })) {
      await createClient().storage.from('receipts').remove([p.v.line.receipt_path])
      await onChanged()
    }
    setBusy(false)
  }

  async function book() {
    const now = chosen
    if (!now.length) return
    // What the results name, as it is now: the lines leave the list once booked
    const labels = Object.fromEntries(now.map(p => [p.v.line.id, `${formatDate(p.v.line.booked_on, lang)} · ${money(Number(p.v.line.amount))} · ${p.payload.title || p.row.transaction.counterparty || '—'}`]))
    setBusy(true)
    setResults(null)
    if (!await saved(now.map(p => p.v.line.id))) { setBusy(false); return }
    const entries = now.map(p => ({ id: p.v.line.id, fingerprint: payloadFingerprint(p.payload) }))
    const items: LineResult[] = []
    for (let i = 0; i < entries.length; i += BOOK_CHUNK) {
      const res = await fetch('/api/bank-lines/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: entries.slice(i, i + BOOK_CHUNK) }) }).catch(() => null)
      if (!res?.ok) {
        toast.error(t('expenses.bookFailed', { error: await failText(t, res) }))
        break
      }
      const body = await res.json().catch(() => null) as { results?: LineResult[] } | null
      items.push(...(body?.results ?? []))
    }
    setResults({ items, labels })
    setSelection({})
    await onChanged()
    setBusy(false)
  }

  async function forgetBooking(v: LineView) {
    setBusy(true)
    const ok = await post(`/api/bank-lines/${v.line.id}/forget`)
    setForget(null)
    if (ok) await onChanged()
    setBusy(false)
  }

  async function discardAttempt(v: LineView, force = false) {
    setBusy(true)
    const res = await fetch(`/api/bank-lines/${v.line.id}/discard${force ? '?force=1' : ''}`, { method: 'POST' }).catch(() => null)
    setForceDiscard(null)
    if (res?.ok) await onChanged()
    else {
      const body = res ? await res.clone().json().catch(() => ({})) as { error?: string } : {}
      toast.error(await failText(t, res))
      // Two bookings Mado cannot tell apart: the owner looks in Bookamat and decides
      if (!force && typeof body.error === 'string' && body.error.includes('nicht eindeutig')) setForceDiscard(v)
    }
    setBusy(false)
  }

  // ─── Receipts from Gmail (PR 9b) ───────────────────────────────────────────

  // One request per line, two at a time; the lines read again once all are done. `auto`: the
  // search after an upload (the server takes only lines from the switch-over date on). A grant
  // without gmail.readonly stops the searches and says so.
  const searchGmail = useCallback(async (ids: readonly string[], auto: boolean) => {
    const queue = [...ids]
    let found = false
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        setSearching(s => ({ ...s, [id!]: true }))
        const res = await fetch(`/api/bank-lines/${id}/receipts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto }) }).catch(() => null)
        setSearching(s => ({ ...s, [id!]: false }))
        const body = res ? await res.json().catch(() => ({})) : {}
        if (res?.ok) {
          if (body.status === 'searched') found = true
          else if (!auto && body.reason) toast.info(body.reason)
        } else if (body?.code === 'google_reauth') {
          setGmailBlocked(true)
          queue.length = 0
        } else if (!auto) {
          toast.error(t('expenses.gmailSearchFailed', { error: res ? apiErrorMessage(t, body) : t('messages.network') }))
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(SEARCHES_AT_ONCE, ids.length) }, worker))
    if (found) await onChanged()
  }, [onChanged, t])

  // By itself, once per line and visit: the open debits from the switch-over date on that have no
  // receipt and were never searched (decision D11)
  useEffect(() => {
    if (kind !== 'expense' || !gmail?.read || !gmail.switchFrom || gmailBlocked) return
    const due = lines.filter(v => v.kind === 'expense' && v.line.status === 'open' && !v.line.bookamat_pending && !v.line.receipt_path
      && !v.line.receipt_search && !v.madoDocument && String(v.line.booked_on) >= gmail.switchFrom! && !autoTried.current.has(v.line.id))
    if (!due.length) return
    for (const v of due) autoTried.current.add(v.line.id)
    void searchGmail(due.map(v => v.line.id), true)
  }, [kind, lines, gmail, gmailBlocked, searchGmail])

  async function attachCandidate(p: Prepared, c: GmailCandidate) {
    setBusy(true)
    if (await saved([p.v.line.id])) {
      const res = await fetch(`/api/bank-lines/${p.v.line.id}/receipts/attach`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: c.message_id, part_id: c.part_id }),
      }).catch(() => null)
      if (res?.ok) await onChanged()
      else {
        const body = res ? await res.json().catch(() => ({})) : {}
        if (body?.code === 'google_reauth') setGmailBlocked(true)
        toast.error(t('expenses.gmailAttachFailed', { error: res ? apiErrorMessage(t, body) : t('messages.network') }))
      }
    }
    setBusy(false)
  }

  // Whether a line can be searched: an open debit, no attempt open, not a Mado document's money,
  // and no Beleg the owner attached (one the search attached is searched again)
  const searchable = (p: Prepared): boolean => kind === 'expense' && !!gmail?.read && !gmailBlocked && p.v.line.status === 'open'
    && !p.pendingLine && !p.v.madoDocument && !p.v.line.receipt_gmail && (!p.v.line.receipt_path || !!p.v.line.receipt_search?.chosen)

  async function attachLater(v: LineView) {
    setBusy(true)
    if (await post(`/api/bank-lines/${v.line.id}/attach`)) {
      toast.success(t('expenses.attached'))
      await onChanged()
    }
    setBusy(false)
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  const pillLabel = (pill: Pill): string => t(`expenses.pill.${pill}`)

  function accountSelect(value: number, list: BookamatAccount[], onChange: (id: string) => void, label: string, disabled: boolean) {
    const known = list.some(a => a.id === value)
    return (
      <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
        <span className="block font-medium">{label}</span>
        <Select value={value ? String(value) : ''} disabled={disabled} onChange={e => onChange(e.target.value)}>
          <option value="">{t('expenses.choose')}</option>
          {!known && value > 0 && <option value={value}>#{value}</option>}
          {list.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      </label>
    )
  }

  function textField(label: string, value: string, onChange: (v: string) => void, disabled: boolean, type: 'text' | 'date' = 'text', placeholder?: string) {
    return (
      <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
        <span className="block font-medium">{label}</span>
        <Input type={type} value={value} placeholder={placeholder} disabled={disabled} onChange={e => onChange(e.target.value)} />
      </label>
    )
  }

  function percentField(label: string, value: number, locked: number | null, onChange: (v: string) => void, disabled: boolean) {
    return (
      <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
        <span className="block font-medium">{label}</span>
        {locked !== null
          ? <p className="text-sm text-neutral-700 dark:text-neutral-200 py-2">{t('expenses.locked', { value: locked })}</p>
          : <Input type="number" min={0} max={100} step="0.01" value={String(value)} disabled={disabled} onChange={e => onChange(e.target.value)} />}
      </label>
    )
  }

  function rateSelect(value: number, rates: number[], onChange: (v: string) => void, label: string, disabled: boolean) {
    const list = [...new Set([...rates, value])].sort((a, b) => b - a)
    return (
      <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
        <span className="block font-medium">{label}</span>
        <Select value={String(value)} disabled={disabled} onChange={e => onChange(e.target.value)}>
          {list.map(r => <option key={r} value={r}>{r} %</option>)}
        </Select>
      </label>
    )
  }

  function editor(p: Prepared) {
    const { v, row, lists, payload } = p
    const review = p.typed
    const ov = (review.override ?? {}) as Record<string, string>
    const set = (key: string) => (value: string) => setOverride(p, key, value)
    const locked = v.line.status !== 'open' || p.pendingLine || busy
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
          {rateSelect(d.taxPercent, rates(d.purchasetaxAccountId), set('tax_percent'), t('expenses.rate'), locked)}
          {percentField(t('expenses.baAmount'), d.deductAmountPercent, d.locks.amount, set('deductibility_amount_percent'), locked)}
          {percentField(t('expenses.baTax'), d.deductTaxPercent, d.locks.tax, set('deductibility_tax_percent'), locked)}
          {textField(t('expenses.vatin'), ov.vatin ?? d.vatin, set('vatin'), locked)}
          {textField(t('expenses.country'), ov.country ?? d.country, set('country'), locked, 'text', 'AT')}
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
          {rateSelect(d.vatPercent, rates(d.vatAccountId), set('vat_percent'), t('expenses.rate'), locked)}
          {textField(t('expenses.vatin'), ov.vatin ?? d.vatin, set('vatin'), locked)}
          {textField(t('expenses.country'), ov.country ?? d.country, set('country'), locked, 'text', 'AT')}
        </div>
      )
    })()

    const splits = review.lines ?? []
    const setSplits = (next: BankLineSplit[]) => setReview(v.line.id, { ...review, lines: next })
    const total = Math.abs(Number(v.line.amount))
    const choices = v.kind === 'expense' ? ((row as MatchedTransaction).rule_choices ?? []) : []
    const vendorId = v.kind === 'expense' ? (row as MatchedTransaction).vendor?.id : undefined

    return (
      <div className="space-y-4 px-4 sm:px-6 pb-5 pt-1">
        {choices.length > 1 && (
          <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 px-3 py-2 space-y-2">
            <p className="text-xs font-medium text-blue-800 dark:text-blue-300">{t(p.choice ? 'expenses.choiceTitle' : 'expenses.choiceOther')}</p>
            <div className="flex flex-wrap gap-2">
              {choices.map(r => (
                <Button key={r.id} type="button" variant={r.id === vendorId ? 'default' : 'outline'} disabled={locked || r.id === vendorId} onClick={() => void pickRuleFor(p, r.id)}>
                  {r.name}{r.id === vendorId ? ` · ${t('expenses.chosen')}` : ''}
                </Button>
              ))}
            </div>
          </div>
        )}
        {fields}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {textField(t('expenses.title'), ov.title ?? payload.title, set('title'), locked)}
          {textField(t('expenses.bookingDate'), ov.date ?? payload.date, set('date'), locked, 'date')}
          {textField(t('expenses.invoiceDate'), ov.date_invoice ?? payload.date_invoice ?? '', set('date_invoice'), locked, 'date')}
          {textField(t('expenses.deliveryDate'), ov.date_delivery ?? payload.date_delivery ?? '', set('date_delivery'), locked, 'date')}
        </div>
        {textField(t('expenses.description'), ov.description ?? payload.description, set('description'), locked)}

        {v.kind === 'expense' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('expenses.splitTitle')}</p>
              <div className="flex gap-2">
                {splits.length > 0 && <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => setSplits([])}>{t('expenses.splitRemove')}</Button>}
                <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => setSplits(splits.length
                  ? [...splits, { label: '', amount_gross: 0, vat_percent: 0 }]
                  : [{ label: '', amount_gross: total, vat_percent: Number(payload.amounts[0]?.tax_percent ?? 20) }, { label: '', amount_gross: 0, vat_percent: 0 }])}>
                  <Plus size={14} /> {t('expenses.splitAdd')}
                </Button>
              </div>
            </div>
            {splits.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_7rem_6rem_2.5rem] gap-2 items-end">
                {textField(t('expenses.splitLabel'), s.label, value => setSplits(splits.map((x, k) => (k === i ? { ...x, label: value } : x))), locked)}
                <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
                  <span className="block font-medium">{t('expenses.splitAmount')}</span>
                  <Input type="number" step="0.01" value={String(s.amount_gross)} disabled={locked} onChange={e => setSplits(splits.map((x, k) => (k === i ? { ...x, amount_gross: Number(e.target.value) || 0 } : x)))} />
                </label>
                {rateSelect(s.vat_percent, [...AT_VAT_RATES, 0], value => setSplits(splits.map((x, k) => (k === i ? { ...x, vat_percent: Number(value) } : x))), t('expenses.rate'), locked)}
                <button type="button" aria-label={t('common.remove')} disabled={locked} onClick={() => setSplits(splits.length > 2 ? splits.filter((_, k) => k !== i) : [])} className="h-9 w-9 flex items-center justify-center rounded-md text-neutral-500 hover:text-red-600 disabled:opacity-40">
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
              {(v.line.receipt_search?.chosen || v.line.receipt_gmail) && <span className="text-[10px] text-neutral-500 dark:text-neutral-400">· {t('expenses.gmailTag')}</span>}
              {!locked && <button type="button" aria-label={t('expenses.receiptRemove')} onClick={() => void removeReceipt(p)} className="ml-1 text-neutral-500 hover:text-red-600"><X size={12} /></button>}
            </span>
          ) : !locked && (
            <label className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800">
              <Paperclip size={12} /> {t('expenses.receiptUpload')}
              <input type="file" accept=".pdf,.jpg,.jpeg,.png,.gif,application/pdf,image/*" className="sr-only" onChange={e => { const f = e.target.files?.[0]; if (f) void uploadReceipt(p, f); e.target.value = '' }} />
            </label>
          )}
          {searchable(p) && (
            <Button type="button" variant="outline" size="sm" disabled={busy || !!searching[v.line.id]} onClick={() => void searchGmail([v.line.id], false)}>
              {searching[v.line.id] ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
              {searching[v.line.id] ? t('expenses.gmailSearching') : t(v.line.receipt_search ? 'expenses.gmailSearchAgain' : 'expenses.gmailSearch')}
            </Button>
          )}
          {v.line.status === 'booked' && v.line.receipt_path && v.booking && !v.booking.pdf_attached_at && (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void attachLater(v)}>{t('expenses.attach')}</Button>
          )}
          {v.line.status === 'open' && !p.pendingLine && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void setStatus(p, 'skipped')}>{t('expenses.skip')}</Button>}
          {v.line.status === 'skipped' && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void setStatus(p, 'open')}>{t('expenses.reopen')}</Button>}
          {p.dup && v.line.status === 'open' && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => ackDuplicate(v.line.id, p.dup!.id)}>{t('expenses.bookAnyway')}</Button>}
          {v.line.status === 'booked' && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setForget(v)}>{t('expenses.forget')}</Button>}
          {p.pendingLine && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void discardAttempt(v)}>{t('expenses.discard')}</Button>}
          {saving[v.line.id] && <span className="text-[11px] text-neutral-400 ml-auto">{t(`expenses.save.${saving[v.line.id]}`)}</span>}
        </div>
        {candidates(p, locked)}
      </div>
    )
  }

  // What the line's Gmail search found and did not attach, each with „Vorschau“ and „Anhängen“
  function candidates(p: Prepared, locked: boolean) {
    const list = kind === 'expense' ? (p.row as MatchedTransaction).gmail_candidates ?? [] : []
    if (!list.length) return null
    const tx = p.row.transaction
    const bankNumber = bankInvoice(tx)?.number ?? null
    return (
      <div className="space-y-1">
        <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{t('expenses.gmailFound')}</p>
        <ul className="space-y-1">
          {list.map(c => (
            <li key={`${c.message_id}:${c.part_id ?? ''}`} className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
              <span className="min-w-0 break-words">{gmailCandidateLine(c, tx, bankNumber)}</span>
              {gmailPreviewable(c) && (
                <a href={`/api/bank-lines/${p.v.line.id}/receipts/preview?message_id=${encodeURIComponent(c.message_id)}&part_id=${encodeURIComponent(c.part_id ?? '')}`}
                  target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-neutral-900 dark:hover:text-neutral-100">
                  <Eye size={12} /> {t('expenses.gmailPreview')}
                </a>
              )}
              {gmailAttachable(c) && !locked && !gmailBlocked && (
                <button type="button" disabled={busy} onClick={() => void attachCandidate(p, c)} className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-50">
                  <Paperclip size={12} /> {t('expenses.gmailAttach')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  function notes(p: Prepared) {
    const { v, row, dup, problems, refund } = p
    const out: { text: string; tone: 'warn' | 'error' | 'info' }[] = []
    if (v.madoDocument) out.push({ text: v.madoDocument, tone: 'info' })
    if (v.gate) out.push({ text: v.gate, tone: 'info' })
    if (hints[v.line.line_key]) out.push({ text: hints[v.line.line_key], tone: 'warn' })
    if (refund) out.push({ text: row.match_note ?? refund, tone: 'info' })
    else if (row.match_note) out.push({ text: row.match_note, tone: 'info' })
    if (row.duplicate_check_failed) out.push({ text: t('expenses.checkFailed', { error: row.duplicate_check_failed }), tone: 'error' })
    if (dup) out.push({ text: t(dup.certain ? 'expenses.duplicateCertain' : 'expenses.duplicatePossible', { title: dup.title, date: formatDate(dup.date, lang), id: dup.id }), tone: dup.certain ? 'error' : 'warn' })
    if (p.pendingLine) out.push({ text: t('expenses.pendingHint'), tone: 'warn' })
    if (p.invalid && v.line.status === 'open') out.push({ text: t('expenses.invalid'), tone: 'error' })
    if (v.line.status === 'open' && !v.gate && !v.madoDocument) for (const pr of problems) out.push({ text: pr.message, tone: pr.blocking ? 'error' : 'warn' })
    return out
  }

  const resultList = results && results.items.length > 0 && (
    <div className="mx-4 sm:mx-6 my-3 rounded-md border border-neutral-200 dark:border-neutral-700 px-3 py-2 space-y-1">
      <p className="text-xs font-medium flex items-center gap-1.5"><CheckCircle2 size={13} className="text-green-600" /> {t('expenses.resultTitle')}</p>
      <ul className="text-xs space-y-1">
        {results.items.map(r => (
          <li key={r.id}>
            {results.labels[r.id] ?? r.id}{' — '}
            {r.status === 'booked' && <span className="text-green-700 dark:text-green-400">{t('expenses.resultBooked', { id: r.bookingId })}{r.corrections.length ? ` · ${r.corrections.join(' · ')}` : ''}{r.receiptError ? ` · ${r.receiptError}` : ''}</span>}
            {r.status === 'duplicate' && (
              <span className="text-amber-700 dark:text-amber-400">
                {t(r.existing.certain ? 'expenses.duplicateCertain' : 'expenses.duplicatePossible', { title: r.existing.title, date: formatDate(r.existing.date, lang), id: r.existing.id })}{' '}
                {lines.some(l => l.line.id === r.id) && (
                  <button type="button" className="underline underline-offset-2" onClick={() => ackDuplicate(r.id, r.existing.id)}>{t('expenses.bookAnyway')}</button>
                )}
              </span>
            )}
            {r.status === 'skipped' && <span className="text-neutral-500">{r.reason}</span>}
            {r.status === 'error' && <span className="text-red-600 dark:text-red-400 whitespace-pre-line">{r.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  )

  const dialogs = (
    <>
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
      <ConfirmDialog
        open={!!forceDiscard}
        title={t('expenses.discardForceTitle')}
        description={t('expenses.discardForceText')}
        confirmLabel={t('expenses.discardForce')}
        destructive
        busy={busy}
        onConfirm={() => { if (forceDiscard) void discardAttempt(forceDiscard, true) }}
        onCancel={() => setForceDiscard(null)}
      />
    </>
  )

  if (!lines.length) {
    return (
      <>
        {resultList}
        <p className="text-sm text-neutral-500 dark:text-neutral-400 px-4 sm:px-6 py-4">{t(kind === 'expense' ? 'expenses.noDebits' : 'expenses.noOtherCredits')}</p>
        {dialogs}
      </>
    )
  }

  // Receipts from Gmail (PR 9b): why none can be searched or read, and when they are by themselves
  const gmailNote = kind === 'expense' && gmail && (
    !gmail.read || gmailBlocked ? (
      <p className="mx-4 sm:mx-6 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
        {t('expenses.gmailReconnect')} <Link href="/settings" className="underline underline-offset-2">{t('expenses.gmailReconnectLink')}</Link>
      </p>
    ) : (
      <>
        {!gmail.reader && <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 px-4 sm:px-6"><AlertTriangle size={13} /> {t('expenses.gmailReaderMissing')}</p>}
        {!gmail.switchFrom && <p className="text-xs text-neutral-500 dark:text-neutral-400 px-4 sm:px-6">{t('expenses.gmailAutoHint')}</p>}
      </>
    )
  )

  return (
    <div className="space-y-3">
      {gmailNote}
      {Object.entries(accountsErrors).map(([year, error]) => (
        <p key={year} className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 px-4 sm:px-6"><AlertTriangle size={13} /> {t('expenses.accountsMissing', { year, error })}</p>
      ))}

      <div className="divide-y divide-neutral-100 dark:divide-neutral-800 border-y border-neutral-100 dark:border-neutral-800">
        <div className="flex items-center gap-3 px-4 sm:px-6 py-2 bg-neutral-50 dark:bg-neutral-800 text-xs text-neutral-500 dark:text-neutral-400">
          <input type="checkbox" className={CHECKBOX_CLS} checked={allChecked} disabled={!bulk.length || busy} aria-label={t('expenses.selectAll')}
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
                  aria-label={t(p.pendingLine ? 'expenses.rebook' : 'expenses.select')} onChange={e => setSelection(s => ({ ...s, [v.line.id]: e.target.checked }))} />
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
                    {searching[v.line.id] && <span className="inline-flex items-center gap-1 text-xs text-neutral-500"><Loader2 size={12} className="animate-spin" /> {t('expenses.gmailSearching')}</span>}
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

      <div className="flex flex-wrap items-center gap-3 px-4 sm:px-6 pb-2">
        <Button type="button" disabled={!chosen.length || busy} onClick={() => void book()} className="px-4">
          {busy ? t('expenses.booking') : plural(chosen.length, 'expenses.bookOne', 'expenses.bookOther')}
        </Button>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('expenses.bookHint')}</p>
      </div>

      {resultList}
      {dialogs}
    </div>
  )
}
