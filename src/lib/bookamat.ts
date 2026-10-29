// Bookamat, server side: one HTTP helper for every route, the account mapping per fiscal year and
// the sync that posts what a document still owes Bookamat exactly once. What a document books
// (Ist: money only, one booking per calendar year) is in bookamat-client.ts.
import type { SupabaseClient } from '@supabase/supabase-js'
import { calcTotals, roundCents, today } from '@/lib/utils/document'
import { creditNoteSettled } from '@/lib/status'
import { isBookamatConfigured } from '@/lib/public-settings'
import { logEvent } from '@/lib/events'
import { isUiLang, makeT, type TFn } from '@/lib/i18n'
import {
  BOOKING_COLUMNS, bookamatErrorMessage, hasMoneyToBook, planBookings, unbookedPlan,
  type AdoptBooking, type BookamatErrorCode, type BookingRow, type ErrorDetail, type MoneyRow, type PlannedBooking,
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

// ─── Sync ────────────────────────────────────────────────────────────────────

export type LoadPdf = (documentId: string) => Promise<{ buffer: Buffer; filename: string }>

const fail = (status: number, code: BookamatErrorCode, error: string, extra: Partial<SyncFailure> = {}): SyncFailure => ({ ok: false, status, code, error, ...extra })

// Bookamat unreachable or failing is a 502; a booking whose fate is still open a 409; the
// database a 500; anything the owner can fix (settings, accounts, a rejected booking) a 400.
function asFailure(err: unknown): SyncFailure {
  if (err instanceof BookamatError) {
    const status = err.code === 'db_write' || err.code === 'database' ? 500
      : err.code === 'unconfirmed' || err.code === 'unknown_outcome' ? 409
      : err.code === 'timeout' || err.code === 'network' || (err.code === 'bookamat' && err.status >= 500) ? 502
      : 400
    return fail(status, err.code, err.message, { detail: err.detail })
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
    return [{ year: o.year as number, kind, booking_id: validId(o.booking_id), amount: o.amount, date: o.date, title: typeof o.title === 'string' ? o.title : '', at: o.at }]
  })
}

// A booking an earlier attempt may have created although its answer never arrived: the year's
// bookings with exactly this title and date. When Bookamat's answer is not visibly filtered by
// them, only the owner can tell, so the sync stops.
async function findBooking(creds: BookamatCredentials, entry: BookamatPending, deadline?: number): Promise<string | null> {
  const q = (v: string) => encodeURIComponent(v).replace(/\./g, '%2E')
  const data: unknown = await bookamatFetch(creds, entry.year, `bookings/?title=${q(entry.title)}&date=${q(entry.date)}&format=json`, { deadline })
  const page = data && typeof data === 'object' && !Array.isArray(data) ? data as { results?: unknown; next?: unknown } : null
  const list = Array.isArray(data) ? data : page?.results
  const items = Array.isArray(list) ? list as { id?: unknown; title?: unknown; date?: unknown }[] : null
  if (!entry.title || !items || page?.next || items.some(i => i?.title !== entry.title || i?.date !== entry.date)) {
    throw new BookamatError('unknown_outcome', `Bookamat ${entry.year} could not be searched for "${entry.title}"`, 0, { year: entry.year, title: entry.title })
  }
  return items.map(i => validId(i.id)).filter((id): id is string => !!id).sort((a, b) => Number(a) - Number(b))[0] ?? null
}

const SYNC_DOC_COLS = `id, type, number, status, currency, date, service_date, service_date_end, tax_treatment, discount_type, discount_value,
  document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value),
  payments(date, amount, kind, method), clients(name, company, uid_number), bookamat_pending, bookamat_bookings(${BOOKING_COLUMNS})`

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
// answer was lost), then journals each post before sending it. Every write is checked, and the
// frozen PDF is attached to each booking recorded.
export async function syncBookamatDocument(
  supabase: SupabaseClient,
  settings: BookamatSettings,
  documentId: string,
  opts: { adopt?: AdoptBooking[]; loadPdf?: LoadPdf; resolver?: AccountResolver; deadline?: number } = {},
): Promise<SyncSuccess | SyncFailure> {
  if (!isBookamatConfigured(settings)) return fail(400, 'not_configured', 'Bookamat is not fully configured')
  const t = settingsT(settings)
  const adopt = opts.adopt ?? []

  const { data, error: docErr } = await supabase.from('documents').select(SYNC_DOC_COLS).eq('id', documentId).maybeSingle()
  if (docErr) return fail(500, 'database', docErr.message)
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
    if (appliedErr) return fail(500, 'database', appliedErr.message)
    const refunded = rows.filter(r => r.kind === 'refund').reduce((s, r) => s + r.amount, 0)
    const settled = creditNoteSettled(totals.total, (applied ?? []).reduce((s, r) => s + Number(r.amount), 0), refunded)
    if (doc.status !== 'sent' || !settled) return fail(400, 'not_settled', 'Only settled credit notes can be synced — record the refund first')
  }

  const plan = planBookings({ type: doc.type, total: totals.total, rows })
  const stored: BookingRow[] = [...(doc.bookamat_bookings ?? [])]
  const leftover = parsePending(doc.bookamat_pending).length > 0
  if (!plan.bookings.length && !stored.length && !leftover && !adopt.length) {
    return fail(400, 'nothing_to_book', 'No money received or paid back on this document — nothing to book')
  }

  const created: SyncSuccess['created'] = []
  const sign = (p: { kind: BookamatBookingKind }) => (p.kind === 'refund' ? -1 : 1)
  const recorded = (e: { year: number; kind: string }) => stored.some(s => s.year === e.year && s.kind === e.kind)

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

  if (adopt.length || leftover || unbookedPlan(plan.bookings, stored).length) {
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
    const saveJournal = async (): Promise<boolean> => {
      const { error } = await supabase.from('documents').update({ bookamat_pending: journal.length ? journal : null }).eq('id', doc.id)
      if (error) console.error(`[bookamat] ${doc.number}: pending bookings not saved:`, error.message)
      return !error
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
        const entry = journal.find(j => j.year === a.year && j.kind === a.kind)
        if (entry) { entry.booking_id ??= a.bookingId; continue }
        const p = unbookedPlan(plan.bookings, stored).find(x => x.year === a.year && x.kind === a.kind)
          ?? plan.bookings.find(x => x.year === a.year && x.kind === a.kind)
        if (p) journal.push({ year: a.year, kind: a.kind, booking_id: a.bookingId, amount: p.amount, date: p.date, title: '', at: claimedAt })
      }
      const kept: BookamatPending[] = []
      for (const entry of journal) {
        if (recorded(entry)) continue
        let bookingId = entry.booking_id
        if (!bookingId) {
          bookingId = await findBooking(creds, entry, opts.deadline)
          if (!bookingId) {
            if (Date.now() - Date.parse(entry.at) < UNCONFIRMED_MS) {
              throw new BookamatError('unconfirmed', `Bookamat has not confirmed the ${entry.year} booking yet`, 0, { year: entry.year })
            }
            // The post never reached Bookamat: booked again below.
            continue
          }
        }
        if (!(await record({ year: entry.year, kind: entry.kind, date: entry.date, amount: entry.amount, cash: 0 }, bookingId, true))) {
          kept.push({ ...entry, booking_id: bookingId })
          unrecorded.push({ year: entry.year, kind: entry.kind, bookingId })
        }
      }
      journal = kept
      if (JSON.stringify(journal) !== journalBefore) await saveJournal()
      if (unrecorded.length) throw unrecordedError()

      // 2. Book what is still missing.
      const todo = unbookedPlan(plan.bookings, stored)
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
        if (opts.deadline && opts.deadline - Date.now() < MIN_POST_MS) throw new BookamatError('timeout', 'Not enough time left in this run to book', 0)
        // Written before the post: if its answer is lost (timeout, the function ends), the next
        // sync looks the booking up in Bookamat instead of posting it again.
        const entry: BookamatPending = { year: p.year, kind: p.kind, booking_id: null, amount: p.amount, date: p.date, title: body.title, at: new Date().toISOString() }
        journal.push(entry)
        if (!(await saveJournal())) {
          journal.pop()
          throw new BookamatError('database', 'The booking could not be prepared here; nothing was sent to Bookamat')
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
          unrecorded.push({ year: p.year, kind: p.kind, bookingId })
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
    return { attached: 0, attachedIds: [], error: t('books.sync.pdfLoadFailed', { error: err instanceof Error ? err.message : String(err) }) }
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

// Forgets the bookings of a document so it can be synced again; only after they were deleted in
// Bookamat, or the next sync books twice. It takes the claim like a sync, so it never pulls the
// bookings from under a sync that is running.
export async function resetBookamatSync(supabase: SupabaseClient, documentId: string): Promise<SyncFailure | null> {
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
  const { error } = await supabase.from('bookamat_bookings').delete().eq('document_id', documentId)
  const { error: docErr } = await supabase.from('documents')
    .update({ ...(error ? {} : { bookamat_booking_id: null, bookamat_error: null, bookamat_pending: null }), bookamat_claimed_at: null })
    .eq('id', documentId)
    .eq('bookamat_claimed_at', claimedAt)
  const message = error?.message ?? docErr?.message
  return message ? fail(500, 'database', message) : null
}

export type AutoSyncResult = { number: string; ok: boolean; bookings?: string[]; error?: string }

// The daily cron step: paid invoices and refunded credit notes from this and last year that have
// no booking yet, failed before or have pending bookings, oldest first, documents that failed
// before last. It ends by `deadline`, so the cron keeps its time for the reminders.
export async function autoSyncBookamat(
  supabase: SupabaseClient,
  settings: BookamatSettings,
  loadPdf: LoadPdf,
  { limit = 10, deadline = Date.now() + 35_000 }: { limit?: number; deadline?: number } = {},
): Promise<AutoSyncResult[]> {
  const year = Number(today().slice(0, 4))
  const since = `${year - 1}-01-01`
  const { data, error } = await supabase
    .from('documents')
    .select('id, type, number, status, date, bookamat_error, bookamat_booking_id, bookamat_pending, bookamat_bookings(id), payments(kind, amount)')
    .in('type', ['invoice', 'credit_note'])
    .not('number', 'is', null)
    .in('status', ['paid', 'cancelled', 'sent'])
    .is('bookamat_booking_id', null)
    .gte('date', since)
    .order('date')
  if (error) throw new Error(error.message)

  const t = settingsT(settings)
  const candidates = ((data ?? []) as unknown as (StateInput & { id: string; number: string; bookamat_pending: unknown })[])
    .filter(d => parsePending(d.bookamat_pending).length > 0 || ((!d.bookamat_bookings?.length || !!d.bookamat_error) && hasMoneyToBook(d)))
    .sort((a, b) => Number(!!a.bookamat_error) - Number(!!b.bookamat_error))

  const results: AutoSyncResult[] = []
  const resolver = new AccountResolver(credentialsOf(settings), settings.bookamat_accounts_year, deadline)
  for (const doc of candidates.slice(0, limit)) {
    if (deadline - Date.now() < MIN_POST_MS) break
    let outcome = await syncBookamatDocument(supabase, settings, doc.id, { loadPdf, resolver, deadline })
    // Bookamat has the booking but the database did not take it: hand it straight back.
    if (!outcome.ok && outcome.pending?.length) outcome = await syncBookamatDocument(supabase, settings, doc.id, { adopt: outcome.pending, loadPdf, resolver, deadline })
    results.push(outcome.ok
      ? { number: doc.number, ok: true, bookings: outcome.created.map(c => `${c.bookingId} (${c.year})`) }
      : { number: doc.number, ok: false, error: bookamatErrorMessage(t, outcome) })
    // Bookamat refuses every further call the same way.
    if (!outcome.ok && (outcome.code === 'auth' || outcome.code === 'not_configured')) break
  }
  return results
}
