// Bookamat, server side: one HTTP helper for every route, the account mapping per fiscal year and
// the sync that posts what a document still owes Bookamat exactly once. What a document books
// (Ist: money only, one booking per payment) is in bookamat-client.ts.
import type { SupabaseClient } from '@supabase/supabase-js'
import { calcTotals, roundCents, today } from '@/lib/utils/document'
import { isBookamatConfigured } from '@/lib/public-settings'
import { logEvent } from '@/lib/events'
import { isUiLang, makeT, type TFn } from '@/lib/i18n'
import { clientDisplayName } from '@/lib/utils/clients'
import { archiveErrorMessage } from '@/lib/issued-pdf'
import { bookamatWritesAllowed } from '@/lib/deployment'
import {
  SearchLimitError, WINDOW_DAYS, addDays, bookingKey, candidateFit, describeCandidate, euro, findCandidates, numberPattern, readYear,
  moneyTarget, toBookingLite, yearsBetween, type BookingCandidate, type BookingLite, type BookingRef, type GetPage, type MoneyTarget,
} from '@/lib/bookamat-search'
import {
  BOOKING_COLUMNS, bookamatErrorMessage, hasMoneyToBook, hasUnbookedMoney, planBookings, unbookedPlan,
  type AdoptBooking, type AdoptSuccess, type BookamatErrorCode, type BookingRow, type ErrorDetail, type MoneyRow, type PlannedBooking,
  type StateInput, type SyncFailure, type SyncSuccess,
} from '@/lib/bookamat-client'
import type { BookamatBookingKind, BookamatPending, Settings, VatRate } from '@/types'

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

// Errors saved for the UI (documents.bookamat_error, settings.bookamat_last_error) are worded in
// the owner's UI language.
export function settingsT(settings: Pick<Settings, 'ui_language'>): TFn {
  return makeT(isUiLang(settings.ui_language) ? settings.ui_language : 'en')
}

// ─── Errors ──────────────────────────────────────────────────────────────────

// `candidates`: for 'external_duplicate', the bookings in Bookamat that may be this money.
export class BookamatError extends Error {
  constructor(
    readonly code: BookamatErrorCode, message: string, readonly status = 0, readonly detail: ErrorDetail = {}, readonly body?: unknown,
    readonly candidates?: BookingCandidate[],
  ) {
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

// ─── HTTP ────────────────────────────────────────────────────────────────────

export type BookamatCredentials = { username: string; apiKey: string; country: string }

const BASE = 'https://www.bookamat.com/api/v1/'
const TIMEOUT_MS = 20_000
export const PREVIEW_REFUSAL = 'This deployment does not write to Bookamat: only production books'

export function credentialsOf(settings: Pick<Settings, 'bookamat_username' | 'bookamat_api_key' | 'bookamat_country'>): BookamatCredentials {
  return { username: settings.bookamat_username ?? '', apiKey: settings.bookamat_api_key ?? '', country: settings.bookamat_country || 'at' }
}

function yearBase(creds: BookamatCredentials, year: number): string {
  if (!/^[a-z]{2}$/.test(creds.country)) throw new BookamatError('bookamat', 'Invalid Bookamat country in settings', 400)
  if (!Number.isInteger(year) || year < 2000 || year > 2999) throw new BookamatError('bookamat', `Invalid Bookamat year ${year}`, 400)
  return `${BASE}${creds.country}/${year}/`
}

// Every Bookamat request: the year's base URL, the ApiKey header, a timeout (never past
// `deadline`, the end of the time a cron run has for Bookamat) and Bookamat's error text parsed
// into a BookamatError. `path` is relative to the year ("bookings/"), or an absolute URL inside it
// (a list's `next` page).
export async function bookamatFetch<T = unknown>(
  creds: BookamatCredentials,
  year: number,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number; deadline?: number } = {},
): Promise<T> {
  if (!creds.username || !creds.apiKey) throw new BookamatError('not_configured', 'Bookamat is not configured', 400)
  // Reads go anywhere; a write (a booking, an attachment) only from production.
  if ((init.method ?? 'GET') !== 'GET' && !bookamatWritesAllowed()) throw new BookamatError('preview', PREVIEW_REFUSAL, 403)
  const base = yearBase(creds, year)
  const url = path.startsWith(base) ? path : `${base}${path}`
  if (!url.startsWith(base) || /[\s#]|\.\./.test(url.slice(base.length))) throw new BookamatError('bookamat', 'Invalid Bookamat path', 400)
  const timeout = Math.min(init.timeoutMs ?? TIMEOUT_MS, init.deadline ? init.deadline - Date.now() : Infinity)
  if (timeout < 1000) throw new BookamatError('timeout', 'No time left for Bookamat in this run')

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
      signal: AbortSignal.timeout(timeout),
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
async function fetchList(creds: BookamatCredentials, year: number, path: string, deadline?: number): Promise<BookamatAccount[]> {
  const out: BookamatAccount[] = []
  let next: string | null = path
  for (let page = 0; next && page < 20; page++) {
    const data: unknown = await bookamatFetch(creds, year, next, { deadline })
    out.push(...toAccounts(data))
    const link = data && typeof data === 'object' && !Array.isArray(data) ? (data as { next?: unknown }).next : null
    // Only a page of the same list is followed (Bookamat may hand it out as http://).
    const url = typeof link === 'string' ? link.replace(/^http:\/\//, 'https://') : ''
    next = url.startsWith(yearBase(creds, year)) ? url : null
  }
  return out
}

export async function fetchBookamatAccounts(creds: BookamatCredentials, year: number, deadline?: number): Promise<BookamatAccounts> {
  const [bankAccounts, costAccounts, vatAccounts] = await Promise.all([
    fetchList(creds, year, 'preferences/bankaccounts/?format=json', deadline),
    fetchList(creds, year, 'preferences/costaccounts/?format=json', deadline),
    fetchList(creds, year, 'preferences/purchasetaxaccounts/?format=json', deadline),
  ])
  return { bankAccounts, costAccounts, vatAccounts }
}

type AccountKind = 'bankAccounts' | 'costAccounts' | 'vatAccounts'
const norm = (s: string) => s.trim().toLowerCase()

// Bookamat keeps separate accounts per fiscal year. The ids in Settings were picked in one year
// (`configuredYear`; null for settings saved before it was stored: then this or last year); a
// booking in another year uses the account with the same title there.
export class AccountResolver {
  private lists = new Map<number, Promise<BookamatAccounts>>()

  constructor(private creds: BookamatCredentials, private configuredYear: number | null, private deadline?: number) {}

  private accounts(year: number) {
    let p = this.lists.get(year)
    if (!p) {
      p = fetchBookamatAccounts(this.creds, year, this.deadline)
      p.catch(() => this.lists.delete(year))
      this.lists.set(year, p)
    }
    return p
  }

  async resolve(year: number, kind: AccountKind, id: number): Promise<number> {
    const inYear = (await this.accounts(year))[kind]
    if (inYear.some(a => a.id === id)) return id
    const current = Number(today().slice(0, 4))
    const sources = this.configuredYear != null ? [this.configuredYear] : [current, current - 1]
    let title: string | undefined
    for (const source of sources) {
      if (source === year) continue
      const list = this.configuredYear != null
        ? await this.accounts(source)
        : await this.accounts(source).catch(() => null)
      title = list?.[kind].find(a => a.id === id)?.title
      if (title) break
    }
    const match = title ? inYear.find(a => norm(a.title) === norm(title)) : undefined
    if (match) return match.id
    if (!title && this.configuredYear == null) {
      throw new BookamatError('accounts_stale', `Bookamat account #${id} from Settings was not found; load and save the accounts again`, 400)
    }
    throw new BookamatError('account_missing', `Account ${title ? `"${title}"` : `#${id}`} does not exist in Bookamat ${year}`, 400, { year, account: title ?? `#${id}` })
  }
}

// ─── Booking lines ───────────────────────────────────────────────────────────

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
// bank and cash. The split is cumulative: of the money booked up to and including this payment,
// each group has its share in cents, the largest group (the first of equals) the rest, so the
// shares always add up to that money; the booking carries the shares of the money up to it less
// those of the money before it (`before`). So every booking adds up to its amount, and a
// document's bookings add up per VAT rate to exactly what one booking of all its money carries.
export function bookingLines(plan: PlannedBooking, groups: { rate: VatRate; base: number; amount: number }[], accounts: BookingAccounts): BookingLine[] {
  const gross = groups.map(g => g.base + g.amount)
  const grossTotal = gross.reduce((s, x) => s + x, 0)
  if (!(grossTotal > 0)) return []
  const largest = gross.reduce((best, x, i) => (x > gross[best] ? i : best), 0)
  const shareOf = (money: number) => {
    const share = gross.map((x, i) => (i === largest ? 0 : roundCents(money * x / grossTotal)))
    share[largest] = roundCents(money - share.reduce((s, x) => s + x, 0))
    return share
  }
  const upTo = shareOf(roundCents(plan.before + plan.amount))
  const prior = shareOf(plan.before)
  const perGroup = groups.map((g, i) => ({ rate: g.rate, gross: roundCents(upTo[i] - prior[i]) }))

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
export function vatAccounts(settings: BookamatSettings, taxTreatment: string | null): Partial<Record<VatRate, number>> {
  const zero = taxTreatment === 'eu_reverse_charge' ? settings.bookamat_vat_account_rc
    : taxTreatment === 'non_eu' ? settings.bookamat_vat_account_non_eu
    : settings.bookamat_vat_account_0
  const map: Partial<Record<VatRate, number | null>> = {
    0: zero, 10: settings.bookamat_vat_account_10, 13: settings.bookamat_vat_account_13, 20: settings.bookamat_vat_account_20,
  }
  return Object.fromEntries(Object.entries(map).filter(([, v]) => v != null)) as Partial<Record<VatRate, number>>
}

// ─── Sync ────────────────────────────────────────────────────────────────────

export type LoadPdf = (documentId: string) => Promise<{ buffer: Buffer; filename: string }>

const fail = (status: number, code: BookamatErrorCode, error: string, extra: Partial<SyncFailure> = {}): SyncFailure => ({ ok: false, status, code, error, ...extra })

// Bookamat unreachable or failing is a 502; a booking whose fate is still open a 409; the
// database a 500; anything the owner can fix (settings, accounts, a rejected booking) a 400.
function asFailure(err: unknown): SyncFailure {
  if (err instanceof BookamatError) {
    const status = err.code === 'db_write' || err.code === 'database' ? 500
      : err.code === 'preview' ? 403
      : err.code === 'adopt_not_found' ? 404
      : err.code === 'unconfirmed' || err.code === 'unknown_outcome' || err.code === 'external_duplicate' || err.code === 'adopt_taken' || err.code === 'in_progress' || err.code === 'adopt_unsettled' ? 409
      : err.code === 'timeout' || err.code === 'network' || err.code === 'duplicate_check_failed' || (err.code === 'bookamat' && err.status >= 500) ? 502
      : 400
    return fail(status, err.code, err.message, { detail: err.detail, ...(err.candidates?.length ? { candidates: err.candidates } : {}) })
  }
  return fail(500, 'database', err instanceof Error ? err.message : String(err))
}

const validId = (v: unknown): string | null =>
  (typeof v === 'number' && Number.isInteger(v) && v > 0) || (typeof v === 'string' && /^\d{1,18}$/.test(v)) ? String(v) : null

// An id Bookamat reports for a booking it already has (a 409), if the body names one.
function conflictBookingId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  for (const key of ['id', 'booking', 'booking_id', 'pk']) {
    const id = validId(o[key])
    if (id) return id
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

function parsePending(value: unknown): BookamatPending[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((v): BookamatPending[] => {
    if (!v || typeof v !== 'object') return []
    const o = v as Record<string, unknown>
    const kind = o.kind === 'income' || o.kind === 'refund' ? o.kind as BookamatBookingKind : null
    if (!Number.isInteger(o.year) || !kind || typeof o.amount !== 'number' || !(o.amount > 0)) return []
    if (typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.date) || typeof o.at !== 'string') return []
    const paymentId = typeof o.payment_id === 'string' && /^[0-9a-f-]{36}$/i.test(o.payment_id) ? o.payment_id : null
    return [{ year: o.year as number, kind, payment_id: paymentId, booking_id: validId(o.booking_id), amount: o.amount, date: o.date, title: typeof o.title === 'string' ? o.title : '', at: o.at }]
  })
}

// A booking an earlier attempt may have created although its answer never arrived: the year's
// live booking with exactly this title and date that no document has recorded (a deleted one, or
// one Mado recorded, is another booking that happens to share them). When Bookamat's answer is not
// visibly filtered by them, or two such bookings remain, only the owner can tell, so the sync stops.
async function findBooking(supabase: SupabaseClient, creds: BookamatCredentials, entry: BookamatPending, deadline?: number): Promise<string | null> {
  const q = (v: string) => encodeURIComponent(v).replace(/\./g, '%2E')
  const data: unknown = await bookamatFetch(creds, entry.year, `bookings/?title=${q(entry.title)}&date=${q(entry.date)}&format=json`, { deadline })
  const page = data && typeof data === 'object' && !Array.isArray(data) ? data as { results?: unknown; next?: unknown } : null
  const list = Array.isArray(data) ? data : page?.results
  const items = Array.isArray(list) ? list as { id?: unknown; title?: unknown; date?: unknown; status?: unknown }[] : null
  const unknown = () => new BookamatError('unknown_outcome', `Bookamat ${entry.year} could not be searched for "${entry.title}"`, 0, { year: entry.year, title: entry.title })
  if (!entry.title || !items || page?.next || items.some(i => i?.title !== entry.title || i?.date !== entry.date)) throw unknown()
  const ids = items.filter(i => String(i.status ?? '1') !== '3').map(i => validId(i.id)).filter((id): id is string => !!id)
  if (!ids.length) return null
  const { data: taken, error } = await supabase.from('bookamat_bookings').select('booking_id').eq('year', entry.year).in('booking_id', ids)
  if (error) throw new BookamatError('database', error.message)
  const recordedIds = new Set(((taken ?? []) as { booking_id: string }[]).map(r => String(r.booking_id)))
  const free = ids.filter(id => !recordedIds.has(id))
  if (free.length > 1) throw unknown()
  return free[0] ?? null
}

// A year's bookings as read for one sync, shared by the syncs of one cron run.
export type BookingsCache = Map<number, Promise<BookingLite[]>>

// The bookings Bookamat has that may already be the money about to be booked, made by someone
// other than Mado (Bookmatic, bookamat's own bank import, a hand booking): one naming the
// document's number at any date, or one moving the same amount the same way within ±10 days of a
// payment (src/lib/bookamat-search.ts), each with how it fits Mado's plan (candidateFit). It reads
// whole years: those Mado books in (they must exist), and the document's year and the window's
// (a missing one is empty). Bookings recorded here, for any document, are Mado's own;
// `acknowledged` ones the owner said are other money. A search that fails is a refusal
// ('duplicate_check_failed'), never "nothing there" (Bookmatic audit P0-2).
export async function findExternalBookings(
  supabase: SupabaseClient,
  creds: BookamatCredentials,
  input: {
    number: string
    documentDate: string
    kind: BookamatBookingKind
    todo: PlannedBooking[]
    rows: MoneyRow[]
    total: number
    // Years whose money Mado booked already (a booking found there is a possible double).
    bookedYears?: number[]
    acknowledged?: BookingRef[]
    deadline?: number
    t?: TFn
    cache?: BookingsCache
  },
): Promise<BookingCandidate[]> {
  if (!input.todo.length) return []
  const dates = input.todo.map(p => p.date).sort()
  const mustExist = new Set(input.todo.map(p => p.year))
  const years = [...new Set([
    ...mustExist,
    Number(input.documentDate.slice(0, 4)),
    ...yearsBetween(addDays(dates[0], -WINDOW_DAYS), addDays(dates[dates.length - 1], WINDOW_DAYS)),
  ])].filter(y => Number.isInteger(y) && y >= 2000 && y <= 2999).sort()
  const get: GetPage = (year, path) => bookamatFetch(creds, year, path, { deadline: input.deadline })
  const bookings: BookingLite[] = []
  try {
    for (const year of years) {
      const cached = input.cache?.get(year)
      const read = cached ?? readYear(get, year, { missingIsEmpty: !mustExist.has(year) })
      if (!cached && input.cache) {
        input.cache.set(year, read)
        read.catch(() => input.cache?.delete(year))
      }
      bookings.push(...await read)
    }
  } catch (err) {
    const reason = err instanceof BookamatError && input.t
      ? (err.code === 'year_missing' ? input.t('books.errors.year_missing', { year: err.detail.year ?? '' }) : bookamatErrorMessage(input.t, { code: err.code, error: err.message, detail: err.detail }))
      : err instanceof SearchLimitError && input.t ? input.t('books.duplicates.tooMany', { year: err.year })
      : err instanceof Error ? err.message : String(err)
    throw new BookamatError('duplicate_check_failed', `Bookamat could not be searched for an earlier booking of ${input.number}: ${reason}`, err instanceof BookamatError ? err.status : 0, { reason })
  }
  // Per payment: a booking the owner said is other money counts as such for the payment it was
  // found for (one without a payment, from an older tab, for all of them).
  const acknowledged = input.acknowledged ?? []
  const pattern = numberPattern(input.number)
  const byFound = new Map<string, BookingCandidate>()
  for (const p of input.todo) {
    const exclude = new Set(acknowledged.filter(a => !a.paymentId || a.paymentId === p.paymentId).map(a => bookingKey(a.year, a.bookingId)))
    const targets: MoneyTarget[] = [moneyTarget(p, input.rows, input.total)]
    for (const c of findCandidates({ moneyIn: input.kind === 'income', pattern, targets, bookings, exclude })) {
      const key = bookingKey(c.year, c.bookingId)
      if (!byFound.has(key)) byFound.set(key, { ...c, foundFor: p.paymentId })
    }
  }
  const found = [...byFound.values()].sort((a, b) => a.date.localeCompare(b.date) || Number(a.bookingId) - Number(b.bookingId))
  if (!found.length) return []
  const { data, error } = await supabase.from('bookamat_bookings').select('year, booking_id').in('booking_id', [...new Set(found.map(c => c.bookingId))])
  if (error) throw new BookamatError('database', error.message)
  const recorded = new Set(((data ?? []) as { year: number; booking_id: string }[]).map(r => bookingKey(Number(r.year), String(r.booking_id))))
  const byKey = new Map(bookings.map(b => [bookingKey(b.year, b.id), b]))
  const planned = input.todo.map(p => ({ year: p.year, amount: p.amount, paymentId: p.paymentId, date: p.date }))
  return found
    .filter(c => !recorded.has(bookingKey(c.year, c.bookingId)))
    .map(c => ({ ...c, ...candidateFit(byKey.get(bookingKey(c.year, c.bookingId))!, { documentNumber: input.number, planned, bookedYears: input.bookedYears }) }))
}

// What a document's money is booked against, as the sync, the take-over and Claude's preview
// require it: there must be money to book (D2: each payment once it is recorded, a part payment
// too). An invoice books against its total (an applied credit note is a row of its own), a credit
// note against its total less what it credited to invoices, so a refund of the rest is no part.
export async function bookableTotal(
  supabase: SupabaseClient,
  doc: { id: string; type: 'invoice' | 'credit_note'; number: string | null; status: string; payments: MoneyRow[] | null },
  total: number,
): Promise<number> {
  if (!hasMoneyToBook(doc)) {
    throw new BookamatError('not_settled', `Nothing of ${doc.number} to book yet: record the ${doc.type === 'invoice' ? 'payment' : 'refund'} first`)
  }
  if (doc.type === 'invoice') return total
  const { data, error } = await supabase.from('payments').select('amount').eq('kind', 'credit').eq('credit_note_id', doc.id)
  if (error) throw new BookamatError('database', error.message)
  const applied = ((data ?? []) as { amount: number }[]).reduce((s, r) => s + Number(r.amount), 0)
  return roundCents(Math.max(0, total - applied))
}

const ITEM_RELATION = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'
const SYNC_DOC_RELATIONS = `${ITEM_RELATION},
  payments(id, date, amount, kind, method), bookamat_bookings(${BOOKING_COLUMNS})`
const SYNC_DOC_COLS = `id, type, number, status, currency, date, service_date, service_date_end, tax_treatment, discount_type, discount_value,
  ${SYNC_DOC_RELATIONS}, clients(name, company, uid_number), bookamat_pending`
// The cron's read (opts.unattended) and that of a sync Claude prepared (opts.claudeHold): whole rows,
// so the Claude marks (heldBack, heldSince below) come from the same read as the payments and the
// client the bookings are made of, and a database without the columns holds nothing.
const UNATTENDED_DOC_COLS = `*, ${SYNC_DOC_RELATIONS}, clients(*)`

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
  bookamat_pending: unknown
  bookamat_bookings: BookingRow[] | null
}

// A claim older than this belongs to a sync that died (timeout, crash) and may be taken over.
const CLAIM_TTL_MS = 3 * 60_000
// A post whose answer was lost is only taken as never arrived when Bookamat still has no such
// booking this long after it was sent.
const UNCONFIRMED_MS = 2 * 60_000
// Below this much time left in a cron run nothing is posted or attached any more.
const MIN_POST_MS = 8_000
const MIN_ATTACH_MS = 10_000

// Books what a document still owes Bookamat: every planned yearly booking not recorded yet,
// capped by what the recorded bookings already cover. Under a claim (a conditional update that
// must succeed) it first settles what an earlier attempt left in documents.bookamat_pending or
// the client hands back as `adopt` (record a booking Bookamat accepted, or look up a post whose
// answer was lost). Before the first post it looks in Bookamat for a booking of the same money
// that Mado did not make (findExternalBookings): one found, or a search that failed, books
// nothing; `acknowledge` names bookings the owner said are other money. It then journals each post
// before sending it. Every write is checked, and the
// frozen PDF is attached to each booking recorded. `unattended` (the cron): a document with
// something from a Claude connection the owner has not confirmed (heldBack) is left as it is,
// 'held', before anything is claimed or booked. `claudeHold` (a sync Claude prepared): the same for
// a mark set after the action's state was compared before the run (heldSince); detail.hold says
// whether the client or the payments.
export async function syncBookamatDocument(
  supabase: SupabaseClient,
  settings: BookamatSettings,
  documentId: string,
  opts: {
    adopt?: AdoptBooking[]; loadPdf?: LoadPdf; resolver?: AccountResolver; deadline?: number; unattended?: boolean
    claudeHold?: ClaudeHold; acknowledge?: BookingRef[]; bookingsCache?: BookingsCache
  } = {},
): Promise<SyncSuccess | SyncFailure> {
  if (!isBookamatConfigured(settings)) return fail(400, 'not_configured', 'Bookamat is not fully configured')
  // Before anything is read or written: a preview writes neither the claim nor the journal.
  if (!bookamatWritesAllowed()) return fail(403, 'preview', PREVIEW_REFUSAL)
  const t = settingsT(settings)
  const adopt = opts.adopt ?? []

  const whole = opts.unattended || !!opts.claudeHold
  const { data, error: docErr } = await supabase.from('documents').select(whole ? UNATTENDED_DOC_COLS : SYNC_DOC_COLS).eq('id', documentId).maybeSingle()
  if (docErr) return fail(500, 'database', docErr.message)
  const doc = data as unknown as SyncDoc | null
  if (!doc) return fail(404, 'not_found', 'Document not found')
  const marks = data as unknown as ClaudeMarks
  const held = opts.unattended ? heldBack(marks) : opts.claudeHold ? heldSince(marks, opts.claudeHold) : null
  if (held) return fail(409, 'held', held, { detail: { hold: held === HELD_CLIENT ? 'client' : 'payments' } })
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

  let bookable: number
  try {
    bookable = await bookableTotal(supabase, { ...doc, type: doc.type }, totals.total)
  } catch (err) {
    return asFailure(err)
  }

  const plan = planBookings({ type: doc.type, total: bookable, rows })
  const stored: BookingRow[] = [...(doc.bookamat_bookings ?? [])]
  const leftover = parsePending(doc.bookamat_pending).length > 0
  if (!plan.bookings.length && !stored.length && !leftover && !adopt.length) {
    return fail(400, 'nothing_to_book', 'No money received or paid back on this document — nothing to book')
  }

  const created: SyncSuccess['created'] = []
  const sign = (p: { kind: BookamatBookingKind }) => (p.kind === 'refund' ? -1 : 1)
  // A journal entry (or a row read again) is recorded once Mado has its booking, or its payment has
  // a booking; an entry from before bookings per payment once its year has one (the backfill may
  // have given that row its payment since).
  const recorded = (e: { year: number; kind: string; payment_id?: string | null; booking_id?: string | null }) =>
    stored.some(s => (!!e.booking_id && s.year === e.year && String(s.booking_id) === String(e.booking_id))
      || (e.payment_id ? s.payment_id === e.payment_id : s.year === e.year && s.kind === e.kind))

  async function record(p: PlannedBooking, bookingId: string, adopted: boolean): Promise<boolean> {
    const row = { document_id: doc!.id, year: p.year, booking_id: bookingId, amount: sign(p) * p.amount, kind: p.kind, booked_on: p.date, payment_id: p.paymentId }
    const { error } = await supabase.from('bookamat_bookings').insert(row)
    if (error?.code === '23505') {
      // This booking is recorded already: here (an earlier attempt), or on another payment or
      // document, which makes it no booking of this money.
      const { data: same, error: sameErr } = await supabase.from('bookamat_bookings').select('document_id, payment_id')
        .eq('year', p.year).eq('booking_id', bookingId)
      if (!sameErr && (same ?? []).some(r => r.document_id === doc!.id && (r.payment_id ?? null) === (p.paymentId ?? null))) return true
      if (!sameErr && !(same ?? []).length) {
        // Another request recorded this payment first (an adopt racing a stale claim).
        if (!adopted) console.error(`[bookamat] ${doc!.number}: the payment was already recorded; booking ${bookingId} is a duplicate in Bookamat — delete it there`)
        return true
      }
      console.error(`[bookamat] ${doc!.number}: booking ${bookingId} is recorded on another payment or document`)
      return false
    }
    if (error) {
      console.error(`[bookamat] ${doc!.number} ${p.year}: booking ${bookingId} not recorded:`, error.message)
      return false
    }
    stored.push({ year: row.year, booking_id: bookingId, amount: row.amount, kind: p.kind, booked_on: p.date, pdf_attached_at: null, payment_id: p.paymentId })
    created.push({ year: p.year, bookingId, amount: row.amount, adopted })
    await logEvent(supabase, doc!.id, 'bookamat_synced', { booking_id: bookingId, year: p.year, amount: row.amount, ...(adopted ? { adopted: true } : {}) })
    return true
  }

  if (adopt.length || leftover || unbookedPlan(plan, stored).length) {
    const claimedAt = new Date().toISOString()
    const cutoff = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
    const { data: claimed, error: claimErr } = await supabase
      .from('documents')
      .update({ bookamat_claimed_at: claimedAt })
      .eq('id', doc.id)
      .or(`bookamat_claimed_at.is.null,bookamat_claimed_at.lt."${cutoff}"`)
      .select('bookamat_pending')
    if (claimErr) return fail(500, 'database', claimErr.message)
    if (!claimed?.length) return fail(409, 'in_progress', 'A Bookamat sync of this document is already running')

    let journal = parsePending((claimed[0] as { bookamat_pending: unknown }).bookamat_pending)
    // Written only while this sync still holds its claim: a sync that outlived it (a slow
    // Bookamat search) must not post beside the one that took the claim over.
    const saveJournal = async (): Promise<'saved' | 'lost' | 'failed'> => {
      const { data: kept, error } = await supabase.from('documents')
        .update({ bookamat_pending: journal.length ? journal : null })
        .eq('id', doc.id)
        .eq('bookamat_claimed_at', claimedAt)
        .select('id')
      if (error) {
        console.error(`[bookamat] ${doc.number}: pending bookings not saved:`, error.message)
        return 'failed'
      }
      if (!kept?.length) {
        console.error(`[bookamat] ${doc.number}: another sync took the claim over; pending bookings not saved`)
        return 'lost'
      }
      return 'saved'
    }
    // Bookings Bookamat has that could not be recorded here; they go back to the caller.
    const unrecorded: AdoptBooking[] = []
    const unrecordedError = () => {
      const ids = unrecorded.map(u => u.bookingId).join(', ')
      return new BookamatError('db_write', `Bookamat booking ${ids} was created but could not be recorded here; sync again to adopt it`, 0, { ids })
    }

    try {
      // A sync that held the claim until just now may have booked some of these years.
      const { data: fresh, error: freshErr } = await supabase.from('bookamat_bookings').select(BOOKING_COLUMNS).eq('document_id', doc.id)
      if (freshErr) throw new Error(freshErr.message)
      for (const row of (fresh ?? []) as BookingRow[]) if (!recorded(row)) stored.push(row)

      const creds = credentialsOf(settings)

      // 1. What an earlier attempt left behind.
      const journalBefore = JSON.stringify(journal)
      for (const a of adopt) {
        // The journal entry it answers: the one with its booking id, else the open one of its
        // payment (or, from before bookings per payment, of its year).
        const entry = journal.find(j => j.year === a.year && j.booking_id === a.bookingId)
          ?? journal.find(j => !j.booking_id && j.year === a.year && j.kind === a.kind && (j.payment_id ?? null) === (a.paymentId ?? null))
        if (entry) { entry.booking_id ??= a.bookingId; continue }
        // Not journaled here (only the tab learned of it): the payment it names, while unbooked; an
        // older tab names none, then only the one unbooked payment of its year. Never a guess.
        const open = unbookedPlan(plan, stored).filter(x => x.year === a.year && x.kind === a.kind && (a.paymentId ? x.paymentId === a.paymentId : true))
        const p = a.paymentId || open.length === 1 ? open[0] : undefined
        if (p) journal.push({ year: a.year, kind: a.kind, payment_id: p.paymentId, booking_id: a.bookingId, amount: p.amount, date: p.date, title: '', at: claimedAt })
        else console.error(`[bookamat] ${doc.number}: booking ${a.bookingId} names no unbooked payment; not recorded`)
      }
      const kept: BookamatPending[] = []
      for (const entry of journal) {
        if (recorded(entry)) continue
        let bookingId = entry.booking_id
        if (!bookingId) {
          bookingId = await findBooking(supabase, creds, entry, opts.deadline)
          if (!bookingId) {
            if (Date.now() - Date.parse(entry.at) < UNCONFIRMED_MS) {
              throw new BookamatError('unconfirmed', `Bookamat has not confirmed the ${entry.year} booking yet`, 0, { year: entry.year })
            }
            // The post never reached Bookamat: booked again below.
            continue
          }
        }
        if (!(await record({ year: entry.year, kind: entry.kind, date: entry.date, amount: entry.amount, cash: 0, paymentId: entry.payment_id ?? null, before: 0, part: null }, bookingId, true))) {
          kept.push({ ...entry, booking_id: bookingId })
          unrecorded.push({ year: entry.year, kind: entry.kind, bookingId, paymentId: entry.payment_id ?? null })
        }
      }
      journal = kept
      if (JSON.stringify(journal) !== journalBefore) await saveJournal()
      if (unrecorded.length) throw unrecordedError()

      // 2. Book what is still missing.
      const todo = unbookedPlan(plan, stored)
      const resolver = opts.resolver ?? new AccountResolver(creds, settings.bookamat_accounts_year, opts.deadline)
      const configuredVat = vatAccounts(settings, doc.tax_treatment)
      const missing = todo.length ? totals.vat_groups.find(g => configuredVat[g.rate] == null) : undefined
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
      const clientName = clientDisplayName(client)
      const payloads = await Promise.all(todo.map(async p => {
        const vat: Partial<Record<VatRate, number>> = {}
        for (const g of totals.vat_groups) vat[g.rate] = await resolver.resolve(p.year, 'vatAccounts', configuredVat[g.rate]!)
        const accounts: BookingAccounts = {
          bank: await resolver.resolve(p.year, 'bankAccounts', settings.bookamat_bank_account_id!),
          cash: p.cash > 0 ? await resolver.resolve(p.year, 'bankAccounts', settings.bookamat_cash_account_id!) : null,
          cost: await resolver.resolve(p.year, 'costAccounts', settings.bookamat_cost_account_id!),
          vat,
        }
        const vars = { number: doc.number!, client: clientName, year: p.year, part: p.part ?? 1, date: `${p.date.slice(8, 10)}.${p.date.slice(5, 7)}.${p.date.slice(0, 4)}` }
        return {
          plan: p,
          body: {
            title: `${doc.number}${p.part ? ` (${p.kind === 'refund' ? 'Rückzahlung' : 'Teilzahlung'} ${p.part})` : ''} – ${clientName}`.slice(0, 50),
            date: p.date,
            date_invoice: doc.date,
            // Leistungsdatum: Bookamat requires it for the 0 % accounts (reverse charge, non-EU).
            date_delivery: doc.service_date_end ?? doc.service_date ?? doc.date,
            vatin: client?.uid_number || undefined,
            description: t(p.kind === 'refund' ? 'books.bookamat.refundDescription' : p.part ? 'books.bookamat.partDescription' : 'books.bookamat.description', vars).slice(0, 500),
            amounts: bookingLines(p, totals.vat_groups, accounts),
          },
        }
      }))

      // Last before anything is posted: does Bookamat already have this money from a booking Mado
      // did not make? Then nothing is booked; the owner takes that booking over or says it is other
      // money (`acknowledge`, never given by the cron or Claude). A failed search books nothing too.
      const external = await findExternalBookings(supabase, creds, {
        number: doc.number!, documentDate: doc.date, kind: doc.type === 'invoice' ? 'income' : 'refund', todo, rows, total: bookable,
        bookedYears: stored.map(b => b.year), acknowledged: opts.acknowledge, deadline: opts.deadline, t, cache: opts.bookingsCache,
      })
      if (external.length) {
        const list = external.map(describeCandidate).join('; ')
        throw new BookamatError('external_duplicate', `Bookamat may already have this money: ${list}. Nothing was booked.`, 409, { bookings: list, count: external.length }, undefined, external)
      }

      for (const { plan: p, body } of payloads) {
        if (opts.deadline && opts.deadline - Date.now() < MIN_POST_MS) throw new BookamatError('timeout', 'Not enough time left in this run to book', 0)
        // Written before the post: if its answer is lost (timeout, the function ends), the next
        // sync looks the booking up in Bookamat instead of posting it again.
        const entry: BookamatPending = { year: p.year, kind: p.kind, payment_id: p.paymentId, booking_id: null, amount: p.amount, date: p.date, title: body.title, at: new Date().toISOString() }
        journal.push(entry)
        const saved = await saveJournal()
        if (saved !== 'saved') {
          journal.pop()
          throw saved === 'lost'
            ? new BookamatError('in_progress', 'Another sync of this document took over meanwhile; nothing was sent to Bookamat', 409)
            : new BookamatError('database', 'The booking could not be prepared here; nothing was sent to Bookamat')
        }
        let bookingId: string | null = null
        try {
          const booking = await bookamatFetch<{ id?: unknown }>(creds, p.year, 'bookings/', { method: 'POST', body, deadline: opts.deadline })
          bookingId = validId(booking?.id)
        } catch (err) {
          bookingId = err instanceof BookamatError && err.status === 409 ? conflictBookingId(err.body) : null
          if (!bookingId) {
            if (err instanceof BookamatError && (err.code === 'timeout' || err.code === 'network')) {
              throw new BookamatError('unconfirmed', `Bookamat did not confirm the ${p.year} booking; the next sync checks Bookamat before booking again`, 0, { year: p.year })
            }
            // Refused: nothing was booked.
            journal.pop()
            await saveJournal()
            throw err
          }
        }
        if (!bookingId) throw new BookamatError('unconfirmed', `Bookamat accepted the ${p.year} booking but returned no id`, 0, { year: p.year })
        entry.booking_id = bookingId
        if (await record(p, bookingId, false)) {
          journal = journal.filter(e => e !== entry)
          // Best effort: a stale entry is dropped by the next sync once its year is recorded.
          await saveJournal()
        } else {
          await saveJournal()
          unrecorded.push({ year: p.year, kind: p.kind, bookingId, paymentId: p.paymentId })
          break
        }
      }
      if (unrecorded.length) throw unrecordedError()
    } catch (err) {
      const failure = asFailure(err)
      if (unrecorded.length) failure.pending = unrecorded
      await recordBookamatError(supabase, settings.id, doc.id, bookamatErrorMessage(t, failure))
      return failure
    } finally {
      const { error: releaseErr } = await supabase.from('documents').update({ bookamat_claimed_at: null }).eq('id', doc.id).eq('bookamat_claimed_at', claimedAt)
      if (releaseErr) console.error(`[bookamat] ${doc.number}: claim not released:`, releaseErr.message)
    }
  }

  await recordBookamatError(supabase, settings.id, doc.id, null)

  const pdf: SyncSuccess['pdf'] = { attached: 0, error: null }
  if (created.length && opts.loadPdf) {
    const result = await attachPdf(supabase, settings, doc.id, created.map(c => ({ year: c.year, booking_id: c.bookingId })), opts.loadPdf, opts.deadline)
    pdf.attached = result.attached
    pdf.error = result.error
    for (const row of stored) if (result.attachedIds.includes(row.booking_id)) row.pdf_attached_at = new Date().toISOString()
  }

  return { ok: true, bookings: stored.sort((a, b) => a.year - b.year), created, fees: plan.fees, pdf }
}

// Attaches the frozen PDF of the document to the given bookings (Bookamat keeps it as the
// receipt). The error comes back in the owner's UI language.
export async function attachPdf(
  supabase: SupabaseClient,
  settings: BookamatSettings,
  documentId: string,
  bookings: { year: number; booking_id: string }[],
  loadPdf: LoadPdf,
  deadline?: number,
): Promise<{ attached: number; attachedIds: string[]; error: string | null }> {
  const t = settingsT(settings)
  if (deadline && deadline - Date.now() < MIN_ATTACH_MS) return { attached: 0, attachedIds: [], error: t('books.sync.attachLater') }
  let pdf: { buffer: Buffer; filename: string }
  try {
    pdf = await loadPdf(documentId)
  } catch (err) {
    console.error(`[bookamat] PDF of ${documentId} not loaded:`, err)
    return { attached: 0, attachedIds: [], error: archiveErrorMessage(t, err, t('books.sync.pdfLoadFailed')) }
  }
  const creds = credentialsOf(settings)
  const name = pdf.filename.replace(/["\\/\r\n]/g, '_').slice(0, 50)
  const file = pdf.buffer.toString('base64')
  const attachedIds: string[] = []
  let error: string | null = null
  for (const b of bookings) {
    try {
      // POST bookings/attachments/ takes the file as base64 in JSON.
      await bookamatFetch(creds, b.year, 'bookings/attachments/', { method: 'POST', body: { booking: Number(b.booking_id), name, file }, timeoutMs: 30_000, deadline })
      attachedIds.push(b.booking_id)
    } catch (err) {
      error = bookamatErrorMessage(t, asFailure(err))
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

// What „Buchung vergessen“ forgets: one recorded booking (its payment becomes unbooked and can be
// changed again, payments_booking_guard), or `unsettled`: the attempts whose outcome a sync could
// not settle (bookamat_pending) and the single booking id from before bookamat_bookings.
export type ForgetTarget = { booking: { year: number; bookingId: string } } | { unsettled: true }

// Forgets bookings of a document so its money can be booked again; only after they were deleted
// in Bookamat, or the next sync books twice. A booking is forgotten only once Bookamat no longer
// has it (asked with `creds`; without them, Bookamat not set up, the owner's word counts and the
// duplicate search guards the next sync). It takes the claim like a sync, so it never pulls a
// booking from under a sync that is running. The document's last error goes with it, and the single
// booking id from before bookamat_bookings when it names this booking.
export async function resetBookamatSync(
  supabase: SupabaseClient,
  documentId: string,
  target: ForgetTarget,
  creds?: BookamatCredentials | null,
): Promise<SyncFailure | null> {
  if (!bookamatWritesAllowed()) return fail(403, 'preview', PREVIEW_REFUSAL)
  if ('booking' in target) {
    const { year, bookingId } = target.booking
    const { data: row, error: rowErr } = await supabase.from('bookamat_bookings').select('id')
      .eq('document_id', documentId).eq('year', year).eq('booking_id', bookingId).maybeSingle()
    if (rowErr) return fail(500, 'database', rowErr.message)
    if (!row) return fail(404, 'forget_not_found', 'This booking is not recorded on the document')
  }
  if ('booking' in target && creds) {
    const { year, bookingId } = target.booking
    try {
      const raw = await bookamatFetch(creds, year, `bookings/${bookingId}/?format=json`)
      const status = raw && typeof raw === 'object' ? String((raw as { status?: unknown }).status ?? '1') : '1'
      if (status !== '3') return fail(409, 'forget_still_booked', `Bookamat ${year} still has booking #${bookingId}`, { detail: { id: bookingId, year } })
    } catch (err) {
      // Bookamat answers 404 for a booking it does not have (bookamatFetch calls any 404 year_missing).
      if (!(err instanceof BookamatError && err.code === 'year_missing')) return asFailure(err)
    }
  }
  const claimedAt = new Date().toISOString()
  const cutoff = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
  const { data: claimed, error: claimErr } = await supabase.from('documents')
    .update({ bookamat_claimed_at: claimedAt })
    .eq('id', documentId)
    .or(`bookamat_claimed_at.is.null,bookamat_claimed_at.lt."${cutoff}"`)
    .select('id')
  if (claimErr) return fail(500, 'database', claimErr.message)
  if (!claimed?.length) {
    const { data: exists } = await supabase.from('documents').select('id').eq('id', documentId).maybeSingle()
    return exists ? fail(409, 'in_progress', 'A Bookamat sync of this document is running') : fail(404, 'not_found', 'Document not found')
  }
  let error: { message: string } | null = null
  let missing = false
  if ('booking' in target) {
    const { data, error: delErr } = await supabase.from('bookamat_bookings').delete()
      .eq('document_id', documentId).eq('year', target.booking.year).eq('booking_id', target.booking.bookingId)
      .select('id')
    error = delErr
    missing = !delErr && !data?.length
  }
  const forgotten = !error && !missing
  if (forgotten && 'booking' in target) {
    const { error: legacyErr } = await supabase.from('documents').update({ bookamat_booking_id: null })
      .eq('id', documentId).eq('bookamat_booking_id', target.booking.bookingId)
    if (legacyErr) console.error(`[bookamat] ${documentId}: the old booking id was not cleared:`, legacyErr.message)
  }
  const { error: docErr } = await supabase.from('documents')
    .update({
      ...(forgotten ? { bookamat_error: null, ...('unsettled' in target ? { bookamat_booking_id: null, bookamat_pending: null } : {}) } : {}),
      bookamat_claimed_at: null,
    })
    .eq('id', documentId)
    .eq('bookamat_claimed_at', claimedAt)
  const message = error?.message ?? docErr?.message
  if (message) return fail(500, 'database', message)
  return missing ? fail(404, 'forget_not_found', 'This booking is not recorded on the document') : null
}

// Takes over a booking Bookamat already has for a document's money (one Mado did not make, named by
// the sync's search or the reconciliation): records it as the booking of that payment and posts
// nothing. Only what the sync would book may be taken over (the same readiness), and only a
// booking that is exactly that money: read from Bookamat again, an income booking of a payment's
// amount still to book (±2 cents), naming no other invoice (candidateFit); the payment the search
// named, or the one of that amount nearest the booking's date. Anything else is refused with what
// to do instead. Production only, under the sync's claim; the document's error is cleared once
// nothing is left to book.
export async function adoptExternalBooking(
  supabase: SupabaseClient,
  settings: BookamatSettings,
  documentId: string,
  ref: BookingRef,
): Promise<AdoptSuccess | SyncFailure> {
  if (!isBookamatConfigured(settings)) return fail(400, 'not_configured', 'Bookamat is not fully configured')
  if (!bookamatWritesAllowed()) return fail(403, 'preview', PREVIEW_REFUSAL)

  const { data, error: docErr } = await supabase.from('documents').select(SYNC_DOC_COLS).eq('id', documentId).maybeSingle()
  if (docErr) return fail(500, 'database', docErr.message)
  const doc = data as unknown as SyncDoc | null
  if (!doc) return fail(404, 'not_found', 'Document not found')
  if ((doc.type !== 'invoice' && doc.type !== 'credit_note') || !doc.number) return fail(400, 'not_issued', 'Only issued invoices and credit notes have bookings')
  if ((doc.currency ?? 'EUR') !== 'EUR') return fail(400, 'not_eur', `${doc.number} is in ${doc.currency}`, { detail: { currency: doc.currency ?? '' } })
  if (parsePending(doc.bookamat_pending).length) return fail(409, 'adopt_unsettled', 'An earlier sync of this document is not settled yet: sync it first')

  const totals = calcTotals(
    doc.document_items ?? [],
    [],
    doc.discount_type && doc.discount_value ? { type: doc.discount_type as 'percent' | 'fixed', value: doc.discount_value } : null,
    doc.tax_treatment,
  )
  let bookable: number
  try {
    bookable = await bookableTotal(supabase, { ...doc, type: doc.type }, totals.total)
  } catch (err) {
    return asFailure(err)
  }
  const plan = planBookings({ type: doc.type, total: bookable, rows: doc.payments ?? [] })

  const claimedAt = new Date().toISOString()
  const cutoff = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
  const { data: claimed, error: claimErr } = await supabase
    .from('documents')
    .update({ bookamat_claimed_at: claimedAt })
    .eq('id', doc.id)
    .or(`bookamat_claimed_at.is.null,bookamat_claimed_at.lt."${cutoff}"`)
    .select('id')
  if (claimErr) return fail(500, 'database', claimErr.message)
  if (!claimed?.length) return fail(409, 'in_progress', 'A Bookamat sync of this document is already running')

  try {
    // What is recorded now: a sync that held the claim until just now may have booked this year.
    const { data: fresh, error: freshErr } = await supabase.from('bookamat_bookings').select(BOOKING_COLUMNS).eq('document_id', doc.id)
    if (freshErr) throw new BookamatError('database', freshErr.message)
    const stored = (fresh ?? []) as BookingRow[]
    const todo = unbookedPlan(plan, stored)
    if (!todo.length) throw new BookamatError('adopt_nothing_left', `Everything of ${doc.number} is booked already`, 400, { id: ref.bookingId, number: doc.number })

    let raw: unknown
    try {
      raw = await bookamatFetch(credentialsOf(settings), ref.year, `bookings/${ref.bookingId}/?format=json`)
    } catch (err) {
      // Bookamat answers 404 for a booking it does not have (bookamatFetch calls any 404 year_missing).
      if (err instanceof BookamatError && err.code === 'year_missing') throw new BookamatError('adopt_not_found', `Bookamat ${ref.year} has no booking #${ref.bookingId}`, 404, { id: ref.bookingId, year: ref.year })
      throw err
    }
    const booking = toBookingLite(ref.year, raw)
    if (!booking || booking.id !== ref.bookingId) throw new BookamatError('adopt_not_found', `Bookamat ${ref.year} has no booking #${ref.bookingId}`, 404, { id: ref.bookingId, year: ref.year })
    const kind: BookamatBookingKind = doc.type === 'invoice' ? 'income' : 'refund'
    const planned = todo.map(p => ({ year: p.year, amount: p.amount, paymentId: p.paymentId, date: p.date }))
    // The payment the search named: it must still be unbooked. One booked meanwhile makes this
    // booking a possible second one of it, never the booking of another payment.
    if (ref.paymentId && !planned.some(p => p.paymentId === ref.paymentId)) {
      const own = plan.money.find(p => p.paymentId === ref.paymentId)
      if (!own) throw new BookamatError('not_found', `${doc.number} has no such payment to book`)
      const covering = stored.filter(b => b.payment_id === ref.paymentId)
      const mine = (covering.length ? covering : stored.filter(b => !b.payment_id && b.year === own.year)).map(b => `#${b.booking_id}`).join(', ')
      throw new BookamatError('adopt_payment_booked', `Mado booked this payment of ${doc.number} already (${mine})`, 400, { id: ref.bookingId, bookings: mine })
    }
    const fit = booking.moneyIn !== (kind === 'income')
      ? { fit: 'kind' as const, paymentId: null, planned: undefined, other: undefined }
      : candidateFit(booking, { documentNumber: doc.number, planned: ref.paymentId ? planned.filter(p => p.paymentId === ref.paymentId) : planned, bookedYears: stored.map(b => b.year) })
    if (fit.fit === 'other_number') throw new BookamatError('adopt_other_number', `Booking #${ref.bookingId} names ${fit.other}`, 400, { id: ref.bookingId, other: fit.other ?? '' })
    if (fit.fit === 'kind') throw new BookamatError('adopt_kind', `Booking #${ref.bookingId} is not an income booking of this money`, 400, { id: ref.bookingId })
    if (fit.fit === 'booked') {
      const mine = stored.filter(b => b.year === ref.year).map(b => `#${b.booking_id}`).join(', ')
      throw new BookamatError('adopt_booked_year', `Mado booked the ${ref.year} money of ${doc.number} already (${mine})`, 400, { id: ref.bookingId, year: ref.year, bookings: mine })
    }
    if (fit.fit === 'year') {
      throw new BookamatError('adopt_other_year', `Booking #${ref.bookingId} lies in ${ref.year}; Mado books this money in ${todo.map(p => p.year).join(', ')}`, 400, {
        id: ref.bookingId, year: ref.year, years: todo.map(p => p.year).join(', '),
      })
    }
    if (fit.fit !== 'exact') {
      throw new BookamatError('adopt_mismatch', `Booking #${ref.bookingId} books ${booking.total}, not the ${fit.planned} still to book`, 400, {
        id: ref.bookingId, booked: euro(booking.total), planned: euro(fit.planned ?? 0), year: ref.year,
      })
    }
    const target = todo.find(p => p.paymentId === fit.paymentId) ?? todo.find(p => p.year === ref.year)!

    const { data: taken, error: takenErr } = await supabase.from('bookamat_bookings').select('document_id').eq('year', ref.year).eq('booking_id', ref.bookingId)
    if (takenErr) throw new BookamatError('database', takenErr.message)
    if (taken?.length) throw new BookamatError('adopt_taken', `Booking #${ref.bookingId} is recorded on another document or statement line`, 409, { id: ref.bookingId })

    const sign = kind === 'refund' ? -1 : 1
    const row = { document_id: doc.id, year: ref.year, booking_id: ref.bookingId, amount: sign * booking.total, kind, booked_on: booking.date || target.date, payment_id: target.paymentId }
    const { error: insertErr } = await supabase.from('bookamat_bookings').insert(row)
    if (insertErr?.code === '23505') throw new BookamatError('in_progress', `${doc.number}: this payment was recorded meanwhile`, 409)
    if (insertErr) throw new BookamatError('database', insertErr.message)
    await logEvent(supabase, doc.id, 'bookamat_synced', { booking_id: ref.bookingId, year: ref.year, amount: row.amount, adopted: true, external: true })
    const bookings: BookingRow[] = [...stored, { year: row.year, booking_id: row.booking_id, amount: row.amount, kind: row.kind, booked_on: row.booked_on, pdf_attached_at: null, payment_id: row.payment_id }]
    // Another year still to book keeps the document's error, so the list and the cron keep it open.
    if (!unbookedPlan(plan, bookings).length) await recordBookamatError(supabase, settings.id, doc.id, null)
    return { ok: true, bookings: bookings.sort((a, b) => a.year - b.year), adopted: { year: ref.year, bookingId: ref.bookingId, amount: row.amount, date: row.booked_on, paymentId: row.payment_id } }
  } catch (err) {
    return asFailure(err)
  } finally {
    const { error: releaseErr } = await supabase.from('documents').update({ bookamat_claimed_at: null }).eq('id', doc.id).eq('bookamat_claimed_at', claimedAt)
    if (releaseErr) console.error(`[bookamat] ${doc.number}: claim not released:`, releaseErr.message)
  }
}

// `held`: why the document was left for a later run (neither synced nor failed).
export type AutoSyncResult = { number: string; ok: boolean; bookings?: string[]; error?: string; held?: string }

// Nothing a Claude session wrote is booked unattended (20261105_mcp_drafts.sql), the marks are read
// with whole rows, so a database without the columns holds nothing; the owner's own sync in Mado
// is not held:
// - the document's client was created or changed by Claude and not saved by the owner in Mado
//   since (clients.mcp_written_at): the booking's title carries the client's name, its UID goes to
//   Bookamat as the booking's vatin (reverse charge, ZM), and a document issued before archive
//   copies existed would get its frozen PDF rendered from that client;
// - Claude recorded, changed or removed a payment of the invoice or a refund of the credit note,
//   and the owner has not confirmed them on its page in Mado since (documents.mcp_payments_at):
//   the bookings take their date, their amount and their account (bank or Kassa) from
//   those rows, and a write-off or Skonto Claude recorded makes an invoice paid, so bookable.
const HELD_CLIENT = 'client changed from a Claude connection: save the client in Mado to confirm it'
const HELD_PAYMENTS = 'payments changed from a Claude connection: confirm them on the document in Mado'
type ClaudeMarks = { mcp_payments_at?: string | null; clients: { mcp_written_at?: string | null } | null }
const heldBack = (row: ClaudeMarks | null): string | null =>
  row?.clients?.mcp_written_at ? HELD_CLIENT : row?.mcp_payments_at ? HELD_PAYMENTS : null

// A sync Claude prepared, as its state was compared before the run: the client had no mark (the
// action refuses one) and the payments had the mark `paymentsAt` (null: none). A client mark, or a
// payments mark other than that one, was set while it ran (a parallel call during a run confirmed in
// the chat, where nothing else holds them), so the client or the rows the bookings are made of are
// no longer what was approved. A payments mark the owner cleared meanwhile (confirming them in
// Mado) holds nothing.
export type ClaudeHold = { paymentsAt: string | null }
const heldSince = (row: ClaudeMarks | null, { paymentsAt }: ClaudeHold): string | null =>
  row?.clients?.mcp_written_at ? HELD_CLIENT : row?.mcp_payments_at && row.mcp_payments_at !== paymentsAt ? HELD_PAYMENTS : null

// The daily cron step: invoices and credit notes with money no booking covers yet (a part payment
// too, D2, whenever the document was issued), that failed before or have pending bookings, oldest
// first, documents that failed before last. Unattended it books money from 1 January of last year
// on only: a document with older money still to book is listed as held, for the owner to sync; those with something from a Claude connection the owner has not confirmed
// (heldBack) are listed as held. It ends by `deadline`, so the cron keeps its time for the
// reminders.
export async function autoSyncBookamat(
  supabase: SupabaseClient,
  settings: BookamatSettings,
  loadPdf: LoadPdf,
  { limit = 10, deadline = Date.now() + 35_000 }: { limit?: number; deadline?: number } = {},
): Promise<AutoSyncResult[]> {
  // Vercel runs crons on production only; a local or preview call books nothing.
  if (!bookamatWritesAllowed()) {
    console.warn('[cron/bookamat] skipped: this deployment does not write to Bookamat')
    return []
  }
  const { data, error } = await supabase
    .from('documents')
    .select(`*, ${ITEM_RELATION}, bookamat_bookings(year, kind, amount, payment_id), payments(id, date, kind, amount), clients(*)`)
    .in('type', ['invoice', 'credit_note'])
    .not('number', 'is', null)
    .in('status', ['sent', 'overdue', 'paid', 'cancelled'])
    .is('bookamat_booking_id', null)
    .order('date')
  if (error) throw new Error(error.message)

  const t = settingsT(settings)
  type Candidate = StateInput & ClaudeMarks & Pick<SyncDoc, 'document_items' | 'discount_type' | 'discount_value' | 'tax_treatment'> & { id: string; number: string; bookamat_pending: unknown }
  const docs = (data ?? []) as unknown as Candidate[]
  // What the money books against, as the sync counts it (bookableTotal): a credit note's refunds
  // book what it did not credit to invoices.
  const creditNotes = docs.filter(d => d.type === 'credit_note').map(d => d.id)
  const applied = new Map<string, number>()
  if (creditNotes.length) {
    const { data: credits, error: creditsErr } = await supabase.from('payments').select('credit_note_id, amount').eq('kind', 'credit').in('credit_note_id', creditNotes)
    if (creditsErr) throw new Error(creditsErr.message)
    for (const c of (credits ?? []) as { credit_note_id: string; amount: number }[]) applied.set(c.credit_note_id, roundCents((applied.get(c.credit_note_id) ?? 0) + Number(c.amount)))
  }
  const withTotal = (d: Candidate) => {
    const gross = calcTotals(d.document_items ?? [], [], d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null, d.tax_treatment).total
    return { ...d, total: roundCents(Math.max(0, gross - (applied.get(d.id) ?? 0))) }
  }
  // Money the cron leaves to the owner: still to book and dated before 1 January of last year.
  const since = `${Number(today().slice(0, 4)) - 1}-01-01`
  const oldMoney = (d: Candidate) => {
    const doc = withTotal(d)
    const rows = (doc.payments ?? []).filter(r => !!r.id && !!r.date).map(r => ({ id: r.id, date: r.date!, amount: r.amount, kind: r.kind ?? 'payment' }))
    return unbookedPlan(planBookings({ type: doc.type === 'credit_note' ? 'credit_note' : 'invoice', total: doc.total, rows }), doc.bookamat_bookings ?? [])
      .some(p => p.date < since)
  }
  const heldOld = (d: Candidate) => (oldMoney(d) ? `money from before ${since} still to book: sync it on the document in Mado` : null)
  const candidates = docs
    .filter(d => parsePending(d.bookamat_pending).length > 0 || (!!d.bookamat_error && hasMoneyToBook(d)) || hasUnbookedMoney(withTotal(d)))
    .sort((a, b) => Number(!!a.bookamat_error) - Number(!!b.bookamat_error))

  // Held ones take no place in this run's limit; a pending booking of theirs waits as well.
  const results: AutoSyncResult[] = candidates.flatMap(d => {
    const held = heldBack(d) ?? heldOld(d)
    return held ? [{ number: d.number, ok: false, held }] : []
  })
  const resolver = new AccountResolver(credentialsOf(settings), settings.bookamat_accounts_year, deadline)
  // Each year of Bookamat is read once per run for the duplicate search.
  const bookingsCache: BookingsCache = new Map()
  for (const doc of candidates.filter(d => !heldBack(d) && !heldOld(d)).slice(0, limit)) {
    if (deadline - Date.now() < MIN_POST_MS) break
    // `unattended`: the marks are read again with the rows the bookings are made of, as Claude may
    // have changed the client or the payments since the list was read; the hand-back as well, as it
    // books what is still missing too.
    let outcome = await syncBookamatDocument(supabase, settings, doc.id, { loadPdf, resolver, deadline, unattended: true, bookingsCache })
    // Bookamat has the booking but the database did not take it: hand it straight back.
    if (!outcome.ok && outcome.pending?.length) outcome = await syncBookamatDocument(supabase, settings, doc.id, { adopt: outcome.pending, loadPdf, resolver, deadline, unattended: true, bookingsCache })
    if (!outcome.ok && outcome.code === 'held') {
      results.push({ number: doc.number, ok: false, held: outcome.error })
      continue
    }
    results.push(outcome.ok
      ? { number: doc.number, ok: true, bookings: outcome.created.map(c => `${c.bookingId} (${c.year})`) }
      : { number: doc.number, ok: false, error: bookamatErrorMessage(t, outcome) })
    // Bookamat refuses every further call the same way.
    if (!outcome.ok && (outcome.code === 'auth' || outcome.code === 'not_configured')) break
  }
  return results
}
