// Bookamat: one HTTP helper for every route, the plan of what a document books (Ist: money only,
// one booking per calendar year) and the sync that posts it exactly once.
import type { SupabaseClient } from '@supabase/supabase-js'
import { calcTotals, roundCents, today } from '@/lib/utils/document'
import { creditNoteSettled } from '@/lib/status'
import { isBookamatConfigured } from '@/lib/public-settings'
import { logEvent } from '@/lib/events'
import { isUiLang, makeT, type DictKey, type TFn } from '@/lib/i18n'
import type { BookamatBooking, BookamatBookingKind, BookamatState, Settings, VatRate } from '@/types'

export const BOOKAMAT_SETTINGS_COLUMNS = [
  'id', 'ui_language', 'bookamat_username', 'bookamat_api_key', 'bookamat_country', 'bookamat_bank_account_id',
  'bookamat_cash_account_id', 'bookamat_cost_account_id', 'bookamat_vat_account_0', 'bookamat_vat_account_rc',
  'bookamat_vat_account_non_eu', 'bookamat_vat_account_10', 'bookamat_vat_account_13', 'bookamat_vat_account_20',
  'bookamat_accounts_year', 'bookamat_auto_sync',
].join(', ')

export type BookamatSettings = Pick<Settings,
  | 'id' | 'ui_language' | 'bookamat_username' | 'bookamat_api_key' | 'bookamat_country' | 'bookamat_bank_account_id'
  | 'bookamat_cash_account_id' | 'bookamat_cost_account_id' | 'bookamat_vat_account_0' | 'bookamat_vat_account_rc'
  | 'bookamat_vat_account_non_eu' | 'bookamat_vat_account_10' | 'bookamat_vat_account_13' | 'bookamat_vat_account_20'
  | 'bookamat_accounts_year' | 'bookamat_auto_sync'>

// ─── Errors ──────────────────────────────────────────────────────────────────

// Failures the UI words itself (books.errors.<code>, with `detail` as variables). 'bookamat'
// carries Bookamat's own message.
export type BookamatErrorCode =
  | 'not_configured' | 'not_found' | 'not_issued' | 'not_eur' | 'not_settled' | 'nothing_to_book' | 'no_items'
  | 'cash_account_missing' | 'vat_account_missing' | 'account_missing' | 'in_progress' | 'auth' | 'year_missing'
  | 'timeout' | 'network' | 'bookamat' | 'db_write' | 'not_synced'

export type ErrorDetail = Record<string, string | number>

export class BookamatError extends Error {
  constructor(readonly code: BookamatErrorCode, message: string, readonly status = 0, readonly detail: ErrorDetail = {}, readonly body?: unknown) {
    super(message)
  }
}

// Bookamat answers with DRF-style JSON ({"non_field_errors": ["…"]}); show the messages, not the JSON.
export function bookamatMessage(text: string): string {
  const collect = (v: unknown): string[] =>
    typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(collect) : v && typeof v === 'object' ? Object.values(v).flatMap(collect) : []
  try {
    const messages = collect(JSON.parse(text))
    if (messages.length) return messages.join(' ')
  } catch { /* not JSON */ }
  return text.trim().slice(0, 300) || 'Bookamat request failed'
}

const ERROR_CODES: readonly BookamatErrorCode[] = [
  'not_configured', 'not_found', 'not_issued', 'not_eur', 'not_settled', 'nothing_to_book', 'no_items',
  'cash_account_missing', 'vat_account_missing', 'account_missing', 'in_progress', 'auth', 'year_missing',
  'timeout', 'network', 'bookamat', 'db_write', 'not_synced',
]

// A route's error payload in the UI language; unknown payloads fall back to their raw message.
export function bookamatErrorMessage(t: TFn, payload: unknown, fallback = t('common.unknownError')): string {
  const p = (payload && typeof payload === 'object' ? payload : {}) as { error?: unknown; code?: unknown; detail?: unknown }
  const message = typeof p.error === 'string' && p.error ? p.error : fallback
  const code = ERROR_CODES.find(c => c === p.code)
  if (!code) return message
  const detail = p.detail && typeof p.detail === 'object' ? p.detail as ErrorDetail : {}
  return t(`books.errors.${code}` as DictKey, { message, ...detail })
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

export type BookamatCredentials = { username: string; apiKey: string; country: string }

const BASE = 'https://www.bookamat.com/api/v1/'
const TIMEOUT_MS = 20_000

export function credentialsOf(settings: Pick<Settings, 'bookamat_username' | 'bookamat_api_key' | 'bookamat_country'>): BookamatCredentials {
  return { username: settings.bookamat_username ?? '', apiKey: settings.bookamat_api_key ?? '', country: settings.bookamat_country || 'at' }
}

function yearBase(creds: BookamatCredentials, year: number): string {
  if (!/^[a-z]{2}$/.test(creds.country)) throw new BookamatError('bookamat', 'Invalid Bookamat country in settings', 400)
  if (!Number.isInteger(year) || year < 2000 || year > 2999) throw new BookamatError('bookamat', `Invalid Bookamat year ${year}`, 400)
  return `${BASE}${creds.country}/${year}/`
}

// Every Bookamat request: the year's base URL, the ApiKey header, a timeout and Bookamat's error
// text parsed into a BookamatError. `path` is relative to the year ("bookings/"), or an absolute
// URL inside it (a list's `next` page).
export async function bookamatFetch<T = unknown>(
  creds: BookamatCredentials,
  year: number,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  if (!creds.username || !creds.apiKey) throw new BookamatError('not_configured', 'Bookamat is not configured', 400)
  const base = yearBase(creds, year)
  const url = path.startsWith(base) ? path : `${base}${path}`
  if (!url.startsWith(base) || /[\s#]|\.\./.test(url.slice(base.length))) throw new BookamatError('bookamat', 'Invalid Bookamat path', 400)

  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `ApiKey ${creds.username}:${creds.apiKey}`,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new BookamatError(timedOut ? 'timeout' : 'network', timedOut ? 'Bookamat did not answer in time' : `Bookamat unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }

  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (res.ok) return body as T

  const message = bookamatMessage(text)
  if (res.status === 401 || res.status === 403) throw new BookamatError('auth', message, res.status, {}, body)
  if (res.status === 404 && !path.startsWith('bookings/attachments')) throw new BookamatError('year_missing', message, res.status, { year }, body)
  throw new BookamatError('bookamat', message, res.status, {}, body)
}

// ─── Accounts ────────────────────────────────────────────────────────────────

export type BookamatAccount = { id: number; title: string }
export type BookamatAccounts = { bankAccounts: BookamatAccount[]; costAccounts: BookamatAccount[]; vatAccounts: BookamatAccount[] }

function toAccounts(data: unknown): BookamatAccount[] {
  let arr: unknown[] = []
  if (Array.isArray(data)) arr = data
  else if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    const list = d.results ?? d.objects ?? d.data ?? Object.values(d).find(Array.isArray)
    if (Array.isArray(list)) arr = list
  }
  return arr.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const o = item as Record<string, unknown>
    const id = Number(o.id ?? o.pk ?? 0)
    if (!Number.isInteger(id) || id <= 0) return []
    return [{ id, title: String(o.title ?? o.name ?? o.description ?? o.label ?? id) }]
  })
}

// A list endpoint page by page (Bookamat paginates with `next`), at most 20 pages.
async function fetchList(creds: BookamatCredentials, year: number, path: string): Promise<BookamatAccount[]> {
  const out: BookamatAccount[] = []
  let next: string | null = path
  for (let page = 0; next && page < 20; page++) {
    const data: unknown = await bookamatFetch(creds, year, next)
    out.push(...toAccounts(data))
    const link = data && typeof data === 'object' && !Array.isArray(data) ? (data as { next?: unknown }).next : null
    next = typeof link === 'string' && link ? link : null
  }
  return out
}

export async function fetchBookamatAccounts(creds: BookamatCredentials, year: number): Promise<BookamatAccounts> {
  const [bankAccounts, costAccounts, vatAccounts] = await Promise.all([
    fetchList(creds, year, 'preferences/bankaccounts/?format=json'),
    fetchList(creds, year, 'preferences/costaccounts/?format=json'),
    fetchList(creds, year, 'preferences/purchasetaxaccounts/?format=json'),
  ])
  return { bankAccounts, costAccounts, vatAccounts }
}

type AccountKind = 'bankAccounts' | 'costAccounts' | 'vatAccounts'
const norm = (s: string) => s.trim().toLowerCase()

// Bookamat keeps separate accounts per fiscal year. The ids in Settings were picked in one year;
// a booking in another year uses the account with the same title there.
export class AccountResolver {
  private lists = new Map<number, Promise<BookamatAccounts>>()

  constructor(private creds: BookamatCredentials, private configuredYear: number) {}

  private accounts(year: number) {
    let p = this.lists.get(year)
    if (!p) {
      p = fetchBookamatAccounts(this.creds, year)
      p.catch(() => this.lists.delete(year))
      this.lists.set(year, p)
    }
    return p
  }

  async resolve(year: number, kind: AccountKind, id: number): Promise<number> {
    const inYear = (await this.accounts(year))[kind]
    if (inYear.some(a => a.id === id)) return id
    const configured = year === this.configuredYear ? inYear : (await this.accounts(this.configuredYear))[kind]
    const title = configured.find(a => a.id === id)?.title
    const match = title ? inYear.find(a => norm(a.title) === norm(title)) : undefined
    if (match) return match.id
    throw new BookamatError('account_missing', `Account ${title ? `"${title}"` : `#${id}`} does not exist in Bookamat ${year}`, 400, { year, account: title ?? `#${id}` })
  }
}

// ─── Plan: what a document books ─────────────────────────────────────────────

export type MoneyRow = { date: string; amount: number; kind: string; method?: string | null }

export type PlannedBooking = {
  year: number
  kind: BookamatBookingKind
  // Last money movement of that year: the booking date.
  date: string
  // Gross booked, always positive here; a refund books it negative.
  amount: number
  cash: number
}

// Ist-Besteuerung, money only. An invoice books its 'payment' rows (a Skonto taken, a write-off
// or an applied credit note moves no money and is not booked), a credit note its 'refund' rows.
// One booking per calendar year, dated on that year's last movement. What arrives beyond the
// amount still to be paid (an overpayment) is not turnover and is left out, latest money last.
// Dunning fees and interest ('fee') are reported back, never booked.
export function planBookings(input: { type: 'invoice' | 'credit_note'; total: number; rows: MoneyRow[] }): { bookings: PlannedBooking[]; fees: number } {
  const moneyKind = input.type === 'invoice' ? 'payment' : 'refund'
  const credited = input.type === 'invoice' ? input.rows.filter(r => r.kind === 'credit').reduce((s, r) => s + r.amount, 0) : 0
  const fees = roundCents(input.rows.filter(r => r.kind === 'fee').reduce((s, r) => s + r.amount, 0))
  let remaining = roundCents(Math.max(0, input.total - credited))

  const byYear = new Map<number, MoneyRow[]>()
  for (const r of input.rows) {
    if (r.kind !== moneyKind || !(r.amount > 0)) continue
    const year = Number(r.date.slice(0, 4))
    byYear.set(year, [...(byYear.get(year) ?? []), r])
  }

  const bookings: PlannedBooking[] = []
  for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
    const rows = byYear.get(year)!
    const received = roundCents(rows.reduce((s, r) => s + r.amount, 0))
    const amount = roundCents(Math.min(received, remaining))
    if (amount <= 0) continue
    remaining = roundCents(remaining - amount)
    const cashReceived = rows.filter(r => r.method === 'cash').reduce((s, r) => s + r.amount, 0)
    bookings.push({
      year,
      kind: input.type === 'invoice' ? 'income' : 'refund',
      date: rows.map(r => r.date).sort().at(-1)!,
      amount,
      cash: roundCents(cashReceived * (amount / received)),
    })
  }
  return { bookings, fees }
}

export type BookingAccounts = { bank: number; cash: number | null; cost: number; vat: Partial<Record<VatRate, number>> }

export type BookingLine = {
  bankaccount: number
  costaccount: number
  purchasetaxaccount: number
  amount: string
  tax_percent: string
  deductibility_tax_percent: string
  deductibility_amount_percent: string
}

// The booking's lines: its amount split over the document's VAT groups by their gross, then over
// bank and cash; every split puts the cent of drift on its largest part, so the lines add up to
// the booked amount exactly.
export function bookingLines(plan: PlannedBooking, groups: { rate: VatRate; base: number; amount: number }[], accounts: BookingAccounts): BookingLine[] {
  const grossTotal = groups.reduce((s, g) => s + g.base + g.amount, 0)
  if (!(grossTotal > 0)) return []
  const perGroup = groups.map(g => ({ rate: g.rate, gross: roundCents(plan.amount * (g.base + g.amount) / grossTotal) }))
  const drift = roundCents(plan.amount - perGroup.reduce((s, g) => s + g.gross, 0))
  if (drift !== 0 && perGroup.length) {
    const largest = perGroup.reduce((a, b) => (b.gross > a.gross ? b : a))
    largest.gross = roundCents(largest.gross + drift)
  }

  const cashShare = plan.amount > 0 ? Math.min(1, plan.cash / plan.amount) : 0
  const sign = plan.kind === 'refund' ? -1 : 1
  return perGroup.flatMap(({ rate, gross }) => {
    const cash = accounts.cash != null ? roundCents(gross * cashShare) : 0
    const parts = [
      { account: accounts.bank, amount: roundCents(gross - cash) },
      { account: accounts.cash ?? accounts.bank, amount: cash },
    ]
    return parts.filter(p => p.amount !== 0).map(p => ({
      bankaccount: p.account,
      costaccount: accounts.cost,
      purchasetaxaccount: accounts.vat[rate]!,
      amount: (sign * p.amount).toFixed(2),
      tax_percent: rate.toFixed(2),
      deductibility_tax_percent: '100.00',
      deductibility_amount_percent: '100.00',
    }))
  })
}

// The 0 % account depends on why nothing is charged: reverse charge, non-EU, or a domestic 0 % line.
function vatAccounts(settings: BookamatSettings, taxTreatment: string | null): Partial<Record<VatRate, number>> {
  const zero = taxTreatment === 'eu_reverse_charge' ? settings.bookamat_vat_account_rc
    : taxTreatment === 'non_eu' ? settings.bookamat_vat_account_non_eu
    : settings.bookamat_vat_account_0
  const map: Partial<Record<VatRate, number | null>> = {
    0: zero, 10: settings.bookamat_vat_account_10, 13: settings.bookamat_vat_account_13, 20: settings.bookamat_vat_account_20,
  }
  return Object.fromEntries(Object.entries(map).filter(([, v]) => v != null)) as Partial<Record<VatRate, number>>
}

// ─── State shown in lists ────────────────────────────────────────────────────

type StateInput = {
  type?: string
  number: string | null
  status: string
  bookamat_error?: string | null
  bookamat_booking_id?: string | null
  bookamat_bookings?: unknown[] | null
  payments?: { kind?: string | null; amount: number }[] | null
}

// Something to book: a paid invoice, or a cancelled one that had received money (its Storno books
// the refund); a credit note once money was paid back.
export function hasMoneyToBook(doc: StateInput): boolean {
  if (!doc.number) return false
  const payments = doc.payments ?? []
  if ((doc.type ?? 'invoice') === 'credit_note') return doc.status === 'sent' && payments.some(p => p.kind === 'refund' && p.amount > 0)
  return doc.status === 'paid' || (doc.status === 'cancelled' && payments.some(p => (p.kind ?? 'payment') === 'payment' && p.amount > 0))
}

export function bookamatState(doc: StateInput): BookamatState {
  if (doc.bookamat_error) return 'failed'
  if ((doc.bookamat_bookings?.length ?? 0) > 0 || doc.bookamat_booking_id) return 'synced'
  return hasMoneyToBook(doc) ? 'unsynced' : 'none'
}

// ─── Sync ────────────────────────────────────────────────────────────────────

export type BookingRow = Pick<BookamatBooking, 'year' | 'booking_id' | 'amount' | 'kind' | 'booked_on' | 'pdf_attached_at'>
export const BOOKING_COLUMNS = 'year, booking_id, amount, kind, booked_on, pdf_attached_at'

// A booking Bookamat accepted that could not be recorded here: the client sends it back as
// `adopt` on the retry, which records it instead of booking a second time.
export type PendingBooking = { year: number; kind: BookamatBookingKind; bookingId: string }

export type LoadPdf = (documentId: string) => Promise<{ buffer: Buffer; filename: string }>

export type SyncSuccess = {
  ok: true
  bookings: BookingRow[]
  created: { year: number; bookingId: string; amount: number; adopted: boolean }[]
  fees: number
  pdf: { attached: number; error: string | null }
}

export type SyncFailure = {
  ok: false
  status: number
  code: BookamatErrorCode
  error: string
  detail?: ErrorDetail
  pending?: PendingBooking[]
}

const fail = (status: number, code: BookamatErrorCode, error: string, extra: Partial<SyncFailure> = {}): SyncFailure => ({ ok: false, status, code, error, ...extra })

// Bookamat unreachable or failing is a 502; anything the owner can fix (settings, accounts, a
// rejected booking) a 400.
function asFailure(err: unknown): SyncFailure {
  if (err instanceof BookamatError) {
    const upstream = err.code === 'timeout' || err.code === 'network' || (err.code === 'bookamat' && err.status >= 500)
    return fail(upstream ? 502 : 400, err.code, err.message, { detail: err.detail })
  }
  return fail(500, 'bookamat', err instanceof Error ? err.message : String(err))
}

// An id Bookamat reports for a booking it already has (a 409), if the body names one.
function conflictBookingId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  for (const key of ['id', 'booking', 'booking_id', 'pk']) {
    const v = o[key]
    if ((typeof v === 'number' && Number.isInteger(v) && v > 0) || (typeof v === 'string' && /^\d+$/.test(v))) return String(v)
  }
  return null
}

export async function recordBookamatError(supabase: SupabaseClient, settingsId: string, documentId: string | null, message: string | null) {
  const at = message ? new Date().toISOString() : null
  const writes: PromiseLike<{ error: { message: string } | null }>[] = [
    supabase.from('settings').update({ bookamat_last_error: message, bookamat_last_error_at: at }).eq('id', settingsId),
  ]
  if (documentId) writes.push(supabase.from('documents').update({ bookamat_error: message }).eq('id', documentId))
  for (const { error } of await Promise.all(writes)) {
    if (error) console.error('[bookamat] error state not recorded:', error.message)
  }
}

const SYNC_DOC_COLS = `id, type, number, status, currency, date, service_date, service_date_end, tax_treatment, discount_type, discount_value,
  document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value),
  payments(date, amount, kind, method), clients(name, company, uid_number), bookamat_bookings(${BOOKING_COLUMNS})`

type SyncDoc = {
  id: string
  type: string
  number: string | null
  status: string
  currency: string | null
  date: string
  service_date: string | null
  service_date_end: string | null
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  document_items: Parameters<typeof calcTotals>[0] | null
  payments: MoneyRow[] | null
  clients: { name: string; company: string | null; uid_number: string | null } | null
  bookamat_bookings: BookingRow[] | null
}

// A claim older than this belongs to a sync that died (timeout, crash) and may be taken over.
const CLAIM_TTL_MS = 3 * 60_000

// Books what a document still owes Bookamat: every planned yearly booking not recorded yet. The
// document is claimed first (a conditional update that must succeed), every write is checked, a
// booking Bookamat accepted but this database could not record comes back as `pending`, and the
// frozen PDF is attached to each new booking.
export async function syncBookamatDocument(
  supabase: SupabaseClient,
  settings: BookamatSettings,
  documentId: string,
  opts: { adopt?: PendingBooking[]; loadPdf?: LoadPdf; resolver?: AccountResolver } = {},
): Promise<SyncSuccess | SyncFailure> {
  if (!isBookamatConfigured(settings)) return fail(400, 'not_configured', 'Bookamat is not fully configured')
  const t = makeT(isUiLang(settings.ui_language) ? settings.ui_language : 'en')

  const { data, error: docErr } = await supabase.from('documents').select(SYNC_DOC_COLS).eq('id', documentId).maybeSingle()
  if (docErr) return fail(500, 'bookamat', docErr.message)
  const doc = data as unknown as SyncDoc | null
  if (!doc) return fail(404, 'not_found', 'Document not found')
  if ((doc.type !== 'invoice' && doc.type !== 'credit_note') || !doc.number) return fail(400, 'not_issued', 'Only issued invoices and credit notes can be synced')
  if ((doc.currency ?? 'EUR') !== 'EUR') return fail(400, 'not_eur', `${doc.number} is in ${doc.currency}; Bookamat only receives EUR documents`, { detail: { currency: doc.currency ?? '' } })

  const rows = doc.payments ?? []
  const totals = calcTotals(
    doc.document_items ?? [],
    [],
    doc.discount_type && doc.discount_value ? { type: doc.discount_type as 'percent' | 'fixed', value: doc.discount_value } : null,
    doc.tax_treatment,
  )
  if (!totals.vat_groups.length) return fail(400, 'no_items', 'The document has no lines to book')

  if (doc.type === 'invoice') {
    if (!hasMoneyToBook({ ...doc, type: 'invoice' })) return fail(400, 'not_settled', 'Only fully paid invoices can be synced — record the payment first')
  } else {
    const { data: applied, error: appliedErr } = await supabase.from('payments').select('amount').eq('kind', 'credit').eq('credit_note_id', doc.id)
    if (appliedErr) return fail(500, 'bookamat', appliedErr.message)
    const refunded = rows.filter(r => r.kind === 'refund').reduce((s, r) => s + r.amount, 0)
    const settled = creditNoteSettled(totals.total, (applied ?? []).reduce((s, r) => s + Number(r.amount), 0), refunded)
    if (doc.status !== 'sent' || !settled) return fail(400, 'not_settled', 'Only settled credit notes can be synced — record the refund first')
  }

  const plan = planBookings({ type: doc.type, total: totals.total, rows })
  const existing = doc.bookamat_bookings ?? []
  const has = (p: { year: number; kind: string }) => existing.some(e => e.year === p.year && e.kind === p.kind)
  let todo = plan.bookings.filter(p => !has(p))
  if (!plan.bookings.length && !existing.length) return fail(400, 'nothing_to_book', 'No money received or paid back on this document — nothing to book')

  const created: SyncSuccess['created'] = []
  const stored: BookingRow[] = [...existing]
  const sign = (p: PlannedBooking) => (p.kind === 'refund' ? -1 : 1)

  async function record(p: PlannedBooking, bookingId: string, adopted: boolean): Promise<boolean> {
    const row = { document_id: doc!.id, year: p.year, booking_id: bookingId, amount: sign(p) * p.amount, kind: p.kind, booked_on: p.date }
    const { error } = await supabase.from('bookamat_bookings').insert(row)
    if (error?.code === '23505') {
      // Another request recorded this year first (an adopt racing a stale claim).
      if (!adopted) console.error(`[bookamat] ${doc!.number} ${p.year} was already recorded; booking ${bookingId} is a duplicate in Bookamat — delete it there`)
      return true
    }
    if (error) {
      console.error(`[bookamat] ${doc!.number} ${p.year}: booking ${bookingId} not recorded:`, error.message)
      return false
    }
    stored.push({ year: row.year, booking_id: bookingId, amount: row.amount, kind: p.kind, booked_on: p.date, pdf_attached_at: null })
    created.push({ year: p.year, bookingId, amount: row.amount, adopted })
    await logEvent(supabase, doc!.id, 'bookamat_synced', { booking_id: bookingId, year: p.year, amount: row.amount, ...(adopted ? { adopted: true } : {}) })
    return true
  }

  for (const a of opts.adopt ?? []) {
    const p = todo.find(x => x.year === a.year && x.kind === a.kind)
    if (!p || !/^\d+$/.test(a.bookingId)) continue
    if (!(await record(p, a.bookingId, true))) {
      return fail(500, 'db_write', `Bookamat booking ${a.bookingId} (${a.year}) could not be recorded`, { pending: [a], detail: { ids: a.bookingId } })
    }
    todo = todo.filter(x => x !== p)
  }

  if (todo.length) {
    const claimedAt = new Date().toISOString()
    const cutoff = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
    const { data: claimed, error: claimErr } = await supabase
      .from('documents')
      .update({ bookamat_claimed_at: claimedAt })
      .eq('id', doc.id)
      .or(`bookamat_claimed_at.is.null,bookamat_claimed_at.lt."${cutoff}"`)
      .select('id')
    if (claimErr) return fail(500, 'bookamat', claimErr.message)
    if (!claimed?.length) return fail(409, 'in_progress', 'A Bookamat sync of this document is already running')

    const pending: PendingBooking[] = []
    try {
      const creds = credentialsOf(settings)
      const configuredYear = settings.bookamat_accounts_year ?? Number(today().slice(0, 4))
      const resolver = opts.resolver ?? new AccountResolver(creds, configuredYear)

      const configuredVat = vatAccounts(settings, doc.tax_treatment)
      const missing = totals.vat_groups.find(g => configuredVat[g.rate] == null)
      if (missing) {
        const which = missing.rate !== 0 ? `${missing.rate} %`
          : t(doc.tax_treatment === 'eu_reverse_charge' ? 'books.zero.rc' : doc.tax_treatment === 'non_eu' ? 'books.zero.nonEu' : 'books.zero.domestic')
        throw new BookamatError('vat_account_missing', `No Bookamat VAT account configured for ${which}`, 400, { which })
      }
      if (todo.some(p => p.cash > 0) && !settings.bookamat_cash_account_id) {
        throw new BookamatError('cash_account_missing', 'Money was received in cash, but no Bookamat cash account (Kassa) is configured', 400)
      }

      // Every year's accounts are resolved before anything is posted, so a missing account never
      // leaves a document half booked.
      const client = doc.clients
      const clientName = client?.company || client?.name || ''
      const payloads = await Promise.all(todo.map(async p => {
        const vat: Partial<Record<VatRate, number>> = {}
        for (const g of totals.vat_groups) vat[g.rate] = await resolver.resolve(p.year, 'vatAccounts', configuredVat[g.rate]!)
        const accounts: BookingAccounts = {
          bank: await resolver.resolve(p.year, 'bankAccounts', settings.bookamat_bank_account_id!),
          cash: p.cash > 0 ? await resolver.resolve(p.year, 'bankAccounts', settings.bookamat_cash_account_id!) : null,
          cost: await resolver.resolve(p.year, 'costAccounts', settings.bookamat_cost_account_id!),
          vat,
        }
        const multiYear = plan.bookings.length > 1
        const vars = { number: doc.number!, client: clientName, year: p.year }
        return {
          plan: p,
          body: {
            title: `${doc.number}${multiYear ? ` (${p.year})` : ''} – ${clientName}`.slice(0, 50),
            date: p.date,
            date_invoice: doc.date,
            // Leistungsdatum: Bookamat requires it for the 0 % accounts (reverse charge, non-EU).
            date_delivery: doc.service_date_end ?? doc.service_date ?? doc.date,
            vatin: client?.uid_number || undefined,
            description: t(p.kind === 'refund' ? 'books.bookamat.refundDescription' : multiYear ? 'books.bookamat.yearDescription' : 'books.bookamat.description', vars).slice(0, 500),
            amounts: bookingLines(p, totals.vat_groups, accounts),
          },
        }
      }))

      for (const { plan: p, body } of payloads) {
        let bookingId: string | null = null
        try {
          const booking = await bookamatFetch<{ id?: unknown }>(creds, p.year, 'bookings/', { method: 'POST', body })
          bookingId = booking?.id != null ? String(booking.id) : null
        } catch (err) {
          const existingId = err instanceof BookamatError && err.status === 409 ? conflictBookingId(err.body) : null
          if (!existingId) throw err
          bookingId = existingId
        }
        if (!bookingId) throw new BookamatError('bookamat', 'Bookamat accepted the booking but returned no id')
        if (!(await record(p, bookingId, false))) {
          pending.push({ year: p.year, kind: p.kind, bookingId })
          break
        }
      }
    } catch (err) {
      const failure = asFailure(err)
      if (pending.length) failure.pending = pending
      await recordBookamatError(supabase, settings.id, doc.id, failure.error)
      return failure
    } finally {
      const { error: releaseErr } = await supabase.from('documents').update({ bookamat_claimed_at: null }).eq('id', doc.id).eq('bookamat_claimed_at', claimedAt)
      if (releaseErr) console.error(`[bookamat] ${doc.number}: claim not released:`, releaseErr.message)
    }

    if (pending.length) {
      const ids = pending.map(p => p.bookingId).join(', ')
      const message = `Bookamat booking ${ids} was created but could not be recorded here; sync again to adopt it`
      await recordBookamatError(supabase, settings.id, doc.id, message)
      return fail(500, 'db_write', message, { pending, detail: { ids } })
    }
  }

  await recordBookamatError(supabase, settings.id, doc.id, null)

  const pdf: SyncSuccess['pdf'] = { attached: 0, error: null }
  const fresh = created.filter(c => !c.adopted)
  if (fresh.length && opts.loadPdf) {
    const result = await attachPdf(supabase, settings, doc.id, fresh.map(c => ({ year: c.year, booking_id: c.bookingId })), opts.loadPdf)
    pdf.attached = result.attached
    pdf.error = result.error
    for (const row of stored) if (result.attachedIds.includes(row.booking_id)) row.pdf_attached_at = new Date().toISOString()
  }

  return { ok: true, bookings: stored.sort((a, b) => a.year - b.year), created, fees: plan.fees, pdf }
}

// Attaches the frozen PDF of the document to the given bookings (Bookamat keeps it as the receipt).
export async function attachPdf(
  supabase: SupabaseClient,
  settings: BookamatSettings,
  documentId: string,
  bookings: { year: number; booking_id: string }[],
  loadPdf: LoadPdf,
): Promise<{ attached: number; attachedIds: string[]; error: string | null }> {
  let pdf: { buffer: Buffer; filename: string }
  try {
    pdf = await loadPdf(documentId)
  } catch (err) {
    return { attached: 0, attachedIds: [], error: err instanceof Error ? err.message : String(err) }
  }
  const creds = credentialsOf(settings)
  const name = pdf.filename.replace(/["\\/\r\n]/g, '_').slice(0, 50)
  const file = pdf.buffer.toString('base64')
  const attachedIds: string[] = []
  let error: string | null = null
  for (const b of bookings) {
    try {
      // POST bookings/attachments/ takes the file as base64 in JSON.
      await bookamatFetch(creds, b.year, 'bookings/attachments/', { method: 'POST', body: { booking: Number(b.booking_id), name, file }, timeoutMs: 30_000 })
      attachedIds.push(b.booking_id)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }
  if (attachedIds.length) {
    const { error: markErr } = await supabase.from('bookamat_bookings')
      .update({ pdf_attached_at: new Date().toISOString() })
      .eq('document_id', documentId)
      .in('booking_id', attachedIds)
    if (markErr) console.error('[bookamat] pdf_attached_at not recorded:', markErr.message)
  }
  return { attached: attachedIds.length, attachedIds, error }
}

// Forgets the bookings of a document so it can be synced again; only after they were deleted in
// Bookamat, or the next sync books twice.
export async function resetBookamatSync(supabase: SupabaseClient, documentId: string): Promise<string | null> {
  const { error } = await supabase.from('bookamat_bookings').delete().eq('document_id', documentId)
  if (error) return error.message
  const { error: docErr } = await supabase.from('documents')
    .update({ bookamat_booking_id: null, bookamat_error: null, bookamat_claimed_at: null })
    .eq('id', documentId)
  return docErr?.message ?? null
}

export type AutoSyncResult = { number: string; ok: boolean; bookings?: string[]; error?: string }

// The daily cron step: paid invoices and refunded credit notes from this and last year that
// have no booking yet, oldest first, documents that failed before last; bounded so the cron
// stays within its time limit.
export async function autoSyncBookamat(
  supabase: SupabaseClient,
  settings: BookamatSettings,
  loadPdf: LoadPdf,
  { limit = 10, budgetMs = 35_000 }: { limit?: number; budgetMs?: number } = {},
): Promise<AutoSyncResult[]> {
  const year = Number(today().slice(0, 4))
  const since = `${year - 1}-01-01`
  const { data, error } = await supabase
    .from('documents')
    .select('id, type, number, status, date, bookamat_error, bookamat_booking_id, bookamat_bookings(id), payments(kind, amount)')
    .in('type', ['invoice', 'credit_note'])
    .not('number', 'is', null)
    .in('status', ['paid', 'cancelled', 'sent'])
    .is('bookamat_booking_id', null)
    .gte('date', since)
    .order('date')
  if (error) throw new Error(error.message)

  const candidates = ((data ?? []) as unknown as (StateInput & { id: string; number: string })[])
    .filter(d => !(d.bookamat_bookings?.length) && hasMoneyToBook(d))
    .sort((a, b) => Number(!!a.bookamat_error) - Number(!!b.bookamat_error))

  const started = Date.now()
  const results: AutoSyncResult[] = []
  const resolver = new AccountResolver(credentialsOf(settings), settings.bookamat_accounts_year ?? year)
  for (const doc of candidates.slice(0, limit)) {
    if (Date.now() - started > budgetMs) break
    const outcome = await syncBookamatDocument(supabase, settings, doc.id, { loadPdf, resolver })
    results.push(outcome.ok
      ? { number: doc.number, ok: true, bookings: outcome.created.map(c => `${c.bookingId} (${c.year})`) }
      : { number: doc.number, ok: false, error: outcome.error })
    // Bookamat refuses every further call the same way.
    if (!outcome.ok && (outcome.code === 'auth' || outcome.code === 'not_configured')) break
  }
  return results
}

// ─── Browser side ────────────────────────────────────────────────────────────

// "#123 (2025), #456 (2026)"
export function formatBookings(t: TFn, bookings: { year: number; booking_id?: string; bookingId?: string }[]): string {
  return bookings.map(b => t('books.sync.booking', { id: b.booking_id ?? b.bookingId ?? '', year: b.year })).join(', ')
}

type SyncResponse = { ok: true; data: SyncSuccess } | { ok: false; payload: unknown }

// Calls the sync route. When Bookamat accepted a booking this database could not record, the
// second call hands it back as `adopt`, so it is recorded instead of booked twice.
export async function requestBookamatSync(documentId: string): Promise<SyncResponse> {
  const post = async (adopt?: PendingBooking[]): Promise<SyncResponse> => {
    const res = await fetch('/api/bookamat/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId, ...(adopt ? { adopt } : {}) }),
    }).catch(() => null)
    if (!res) return { ok: false, payload: { code: 'network', error: 'Network error' } }
    const payload: unknown = await res.json().catch(() => ({}))
    return res.ok ? { ok: true, data: payload as SyncSuccess } : { ok: false, payload }
  }
  const first = await post()
  const pending = !first.ok && first.payload && typeof first.payload === 'object' ? (first.payload as { pending?: unknown }).pending : null
  return Array.isArray(pending) && pending.length ? post(pending as PendingBooking[]) : first
}
