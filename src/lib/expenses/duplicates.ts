// Is this payment already in bookamat? Shared by the CSV import (Analyse and the
// booking route) and phone receipt capture, so both jobs answer the same way.
// Pure: no I/O, tested in lib/__tests__/duplicates.test.ts.
//
// What it compares (audit P0-4, P1-6):
// - Booking TOTALS, not lines. bookamat's amount filter matches single lines, so a
//   split receipt (10 % + 20 % + tip) was never found by its total, while a debit
//   equal to one line of an unrelated booking counted as booked.
// - The same direction only: an expense debit never matches an income booking.
// - Each existing booking stands for one purchase: it is matched to at most one row.
// - A date window: a card payment posts 0–5 days after the purchase, so a receipt
//   booked from the phone on the receipt date sits up to 5 days before the debit.
//   Same day = „bereits gebucht“ (certain); an earlier day = „möglicherweise
//   bereits gebucht“ (possible). Either is shown with the booking it matched, and
//   the owner can book anyway.
// - A restaurant receipt booked from the phone also finds its card debit with a tip on
//   top (3 cents to 25 % more, „mit Trinkgeld?“, P2-3): forward only, never certain.
// - The day of payment (lib/booking-dates.ts payDay): a CSV row's card date or
//   Valutadatum before its bank date counts as its day as well, and the window
//   reaches back to it.
import type { EasybankTransaction } from '@/lib/expenses/types'
import { invoiceKey, invoiceIndexKey, madoInvoiceKey } from './invoice-parsing'
import { payDay } from './booking-dates'
import { cents } from './money'

export const CARD_LAG_DAYS = 5

// The fields of a bookamat booking this needs (structurally a BookamatBooking).
export type BookingLike = {
  id: number
  title: string
  date: string
  amounts?: {
    group?: string | number; amount?: string; tax_percent?: string
    // The line's Zahlungsmittelkonto, as bookamat's list answers it
    bankaccount?: { id?: number | string; name?: string } | null
  }[]
}

// `zeroTax`: the booking's 0 % lines (a bank fee the import books as its own line).
// `bank`: the Zahlungsmittelkonto's name when every line names the same one; no key else.
export type BookingLite = { id: number; title: string; date: string; total: number; income: boolean; zeroTax: number; bank?: string }

// What a row matched: shown on the row („<title> am <date>“), and its id is what
// the owner acknowledges with „trotzdem buchen“. `bank` only when known (the receipt's
// duplicate prompt says where the match is booked, P2-4). `viaTip` only when true: a
// restaurant receipt's card debit with a tip on top (P2-3, forward rows only).
export type DuplicateMatch = { id: number; title: string; date: string; total: number; certain: boolean; bank?: string; viaTip?: true }

// This app's own income title, one booking per bank credit ("RN_202605010 - Beispiel
// GmbH", earlier "RN_202601001 Rönngard"). It covers that one payment, so a second
// partial payment of the same invoice is not its duplicate. Any other title naming
// the invoice — Mado's "RN-202605010 – Beispiel GmbH" — books all of that invoice's
// money of the year in one booking.
export const PER_PAYMENT_TITLE = /^\s*RN_\d{6,}(?!\d)/

// Not an expense booking. bookamat marks each line "1" (income) or "2" (expense); a
// booking whose lines carry no group is kept: when in doubt the row is flagged and
// can be booked anyway, while a missed duplicate is booked twice.
export const isIncomeBooking = (b: BookingLike) =>
  !(b.amounts?.length && b.amounts.every(a => a.group != null && String(a.group) === '2'))

// The booking's amount: the size of its signed sum, so a 100,00 line with a −10,00
// voucher line is 90,00 (adding sizes made it 110,00 and missed the re-import).
const signedSum = (b: BookingLike) =>
  (b.amounts ?? []).reduce((s, a) => s + (parseFloat(a.amount ?? '0') || 0), 0)
export const bookingTotal = (b: BookingLike) => Math.abs(signedSum(b))

const round2 = (n: number) => Math.round(n * 100) / 100

// The Zahlungsmittelkonto a booking is booked on: its name when every line names the same
// account (same id, same name), else null — a booking without lines or with mixed accounts
// names none
function bankOf(b: BookingLike): string | null {
  const lines = b.amounts ?? []
  const first = lines[0]?.bankaccount
  const name = typeof first?.name === 'string' ? first.name.trim() : ''
  if (!name) return null
  const same = lines.every(a => !!a.bankaccount && typeof a.bankaccount.name === 'string'
    && a.bankaccount.name.trim() === name && String(a.bankaccount.id) === String(first!.id))
  return same ? name : null
}

export const toBookingLite = (b: BookingLike): BookingLite => {
  const bank = bankOf(b)
  return {
    id: b.id, title: b.title, date: b.date,
    total: round2(bookingTotal(b)),
    // A negative booking moves money the other way (a refund booked as negative income
    // is money out, like a debit)
    income: isIncomeBooking(b) !== (signedSum(b) < 0),
    zeroTax: round2((b.amounts ?? [])
      .filter(a => a.tax_percent != null && parseFloat(a.tax_percent) === 0)
      .reduce((s, a) => s + Math.abs(parseFloat(a.amount ?? '0') || 0), 0)),
    // Only when known, so a booking without it compares as before
    ...(bank ? { bank } : {}),
  }
}

// The booking among `bookings` that books invoice `key` (see invoiceKey) as a whole,
// or null. bookamat's title_contains is a substring match, so "202605010" also
// finds "RN-2026050101"; the key comparison keeps only the same invoice. Expense
// bookings never count.
export function pickInvoiceBooking<T extends BookingLike>(bookings: T[], key: string): T | null {
  return bookings.find(b =>
    invoiceKey(b.title) === key &&
    !PER_PAYMENT_TITLE.test(b.title) &&
    isIncomeBooking(b)
  ) ?? null
}

// The Mado invoice a booking is Mado's booking of („RN-202606013 – Client“), or null
// (this app's per-payment „RN_…“ titles and older invoice numbers are not Mado's).
// A credit matched to such a booking pays that Mado invoice, even when its bank text
// names no number: the payment is Mado's, never booked here.
export function madoBookingOf(b: { title: string }): string | null {
  return PER_PAYMENT_TITLE.test(b.title) ? null : madoInvoiceKey(invoiceKey(b.title))
}

// The import's already-booked index entry (invoiceIndexKey) for a booking that books
// an own invoice as a whole, or null.
export function wholeInvoiceIndexKey(b: BookingLike): string | null {
  const key = invoiceKey(b.title)
  return key && pickInvoiceBooking([b], key) ? invoiceIndexKey(key) : null
}

// YYYY-MM-DD plus n days (UTC, so no time zone can shift the day).
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const dayGap = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

export const normTitle = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

// Within 2 cents: the booking route books a split up to 2 cents off the debit, and a
// restaurant split adds a Trinkgeld line only for more than that
const sameAmount = (a: number, b: number) => Math.abs(a - b) <= 0.02 + 1e-9

// One row to check: a CSV row (bank date, debit incl. a bundled bank fee, the fee-free
// net when there is one) or a phone receipt (receipt date, receipt total).
export type PaymentRow = {
  date: string
  amount: number
  netAmount?: number | null
  income: boolean
  // The title this row books, when known (a Buchungsregel's): preferred on a tie
  title?: string | null
  // The titles of Buchungsregeln that fit this payment equally (lib/rule-match.ts): the
  // row books one of them, the one the owner picks — a booking of any of them is known
  titles?: readonly string[] | null
  // The invoice this credit pays (incomeInvoiceKey); keeps this app's own booking of
  // ANOTHER invoice's payment from counting — two clients can pay the same amount
  // on one day
  invoiceKey?: string | null
  // CSV rows look back (the receipt came first); a receipt looks forward (the card
  // debit posts later). Income rows only match the same day.
  direction: 'back' | 'forward'
  // 'back' rows only: the day the money moved, when before `date` — the card date or the
  // Valutadatum (payDay(tx, kind).payDate). A booking on it is this payment as surely as
  // one on the bank date: a receipt booked from the phone, or this app's booking of a
  // card payment of 30.12. posted on 04.01.
  payDate?: string | null
  // 'forward' expense rows only: a restaurant receipt (the book route: its Steuerkonto is
  // Bewirtung), whose card debit may carry a tip the receipt is booked without (P2-3)
  restaurant?: boolean
}

// A tip on top: the booking is 3 cents to a quarter above the receipt, in whole cents.
// Up to 2 cents is the same amount (sameAmount); more than 25 % is not a tip (the same
// quarter as lib/receipt-totals.ts TIP_MAX_SHARE).
const tipOnTop = (booking: number, receipt: number) => {
  const tip = cents(booking) - cents(receipt)
  return tip >= 3 && tip * 4 <= cents(receipt)
}

// A 'back' row's day of payment, when it lies before the bank date
const payDayOf = (row: Pick<PaymentRow, 'date' | 'payDate' | 'direction'>): string | null =>
  row.direction === 'back' && row.payDate && /^\d{4}-\d{2}-\d{2}$/.test(row.payDate) && row.payDate < row.date
    ? row.payDate : null

// Only a real date near the bank date widens the window: a mistyped one („0026-06-30“)
// would read two thousand years of books; the row's own check reports it instead.
export function nearBankDate(bank: string, d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(`${d}T00:00:00Z`))
    && Math.abs(Number(d.slice(0, 4)) - Number(bank.slice(0, 4))) <= 1
}

// The earliest booking date a row can match. An expense looks CARD_LAG_DAYS back, or back
// to its day of payment when that is earlier (a card payment of 29.12. that the bank posts
// on 04.01.: six days); a credit looks at its bank date and its day of payment; a receipt
// looks forward from its own date.
export function backWindowFrom(row: Pick<PaymentRow, 'date' | 'payDate' | 'income' | 'direction'>): string {
  if (row.direction !== 'back') return row.date
  const pay = payDayOf(row) ?? row.date
  const lag = row.income ? row.date : addDays(row.date, -CARD_LAG_DAYS)
  return pay < lag ? pay : lag
}

// `gapPay`: days between the booking and the day of payment (the bank date without one);
// `gapBank`: days to the bank date. Ranked in that order, so each of two rows of the same
// amount gets the booking on its own day of payment.
function candidate(row: PaymentRow, b: BookingLite): { certain: boolean; gapPay: number; gapBank: number; titleMatch: boolean; viaTip: boolean } | null {
  if (b.income !== row.income) return null
  const amountOk = sameAmount(b.total, Math.abs(row.amount)) ||
    (row.netAmount != null && sameAmount(b.total, Math.abs(row.netAmount)))
  // A receipt checked against its card debit booked from the CSV as goods + 0 %
  // Bankspesen line: the goods are the receipt's total. Never „bereits gebucht“.
  const viaFee = !amountOk && row.direction === 'forward' && !row.income && b.zeroTax > 0 &&
    sameAmount(b.total - b.zeroTax, Math.abs(row.amount))
  // „mit Trinkgeld?“ (P2-3): a restaurant receipt booked from the phone without its tip,
  // weeks after its card debit was booked from the CSV with the tip on top. Forward rows
  // only — the import's 'back' rows never use it. Never „bereits gebucht“.
  const viaTip = !amountOk && !viaFee && row.direction === 'forward' && !row.income && !!row.restaurant &&
    tipOnTop(b.total, Math.abs(row.amount))
  if (!amountOk && !viaFee && !viaTip) return null
  const pay = payDayOf(row)
  const gapBank = row.direction === 'back' ? dayGap(b.date, row.date) : dayGap(row.date, b.date)
  const gapPay = pay ? Math.abs(dayGap(pay, b.date)) : gapBank
  // The day of payment: the bank date, or a 'back' row's earlier card date or Valutadatum
  const onPaymentDay = gapBank === 0 || (!!pay && gapPay === 0)
  if (row.income) {
    if (!onPaymentDay) return null
  } else {
    const maxGap = row.direction === 'back' ? dayGap(backWindowFrom(row), row.date) : CARD_LAG_DAYS
    if (gapBank < 0 || gapBank > maxGap) return null
  }
  if (row.income && row.invoiceKey && PER_PAYMENT_TITLE.test(b.title) && invoiceKey(b.title) !== row.invoiceKey) return null
  // The same title (one of the tied rules' titles), or — for a credit — a booking naming
  // the same own invoice (Mado's „RN-202605010 – Beispiel GmbH“ for this app's
  // „RN_202605010 - …“)
  const titleMatch = (!!row.title && normTitle(row.title) === normTitle(b.title)) ||
    (row.titles ?? []).some(t => normTitle(t) === normTitle(b.title)) ||
    (row.income && !!row.invoiceKey && invoiceKey(b.title) === row.invoiceKey)
  // „Bereits gebucht“ only for the day of payment and, when the row's title is known,
  // the same title: „Internet Studio“ and „Internet Home Office“ share a day and an
  // amount, and one booked must not make the other look booked. A row whose rules tie
  // knows their titles: a booking of one of them is its own, another title is not.
  // Anything else in the window is „möglicherweise bereits gebucht“.
  const known = !!row.title || !!row.titles?.length
  return { certain: !viaFee && !viaTip && onPaymentDay && (titleMatch || !known), gapPay, gapBank, titleMatch, viaTip }
}

// For each row, the existing booking it most likely repeats, or null. Each booking
// is used for one row only: same day and same title first, then same day, then the
// nearest date — so of two 40,52 € Magenta debits on one day, only one is „bereits
// gebucht“ when only one booking exists. Rows already acknowledged by the owner
// pass their acknowledged ids in `excludeIds`.
export function assignDuplicates(
  rows: PaymentRow[],
  bookings: BookingLite[],
  excludeIds: ReadonlySet<number> = new Set(),
): (DuplicateMatch | null)[] {
  const pairs: { r: number; b: BookingLite; certain: boolean; gapPay: number; gapBank: number; titleMatch: boolean; viaTip: boolean }[] = []
  rows.forEach((row, r) => {
    for (const b of bookings) {
      if (excludeIds.has(b.id)) continue
      const c = candidate(row, b)
      if (c) pairs.push({ r, b, ...c })
    }
  })
  pairs.sort((x, y) =>
    Number(!x.certain) - Number(!y.certain) ||
    // The same amount before a tip on top (only a forward restaurant row has either)
    Number(x.viaTip) - Number(y.viaTip) ||
    Number(!x.titleMatch) - Number(!y.titleMatch) ||
    x.gapPay - y.gapPay ||
    x.gapBank - y.gapBank ||
    x.r - y.r ||
    x.b.id - y.b.id)
  const out: (DuplicateMatch | null)[] = rows.map(() => null)
  const used = new Set<number>()
  for (const p of pairs) {
    if (out[p.r] || used.has(p.b.id)) continue
    out[p.r] = {
      id: p.b.id, title: p.b.title, date: p.b.date, total: p.b.total, certain: p.certain,
      ...(p.b.bank ? { bank: p.b.bank } : {}),
      ...(p.viaTip ? { viaTip: true as const } : {}),
    }
    used.add(p.b.id)
  }
  return out
}

// The bookamat date range to read for these rows: the window each row looks into, from
// the earliest day any of them looks back to.
export function windowFor(rows: Pick<PaymentRow, 'date' | 'payDate' | 'direction' | 'income'>[]): { from: string; until: string } | null {
  if (!rows.length) return null
  const dates = rows.map(r => r.date).sort()
  const fwd = rows.some(r => r.direction === 'forward' && !r.income) ? CARD_LAG_DAYS : 0
  return { from: rows.map(backWindowFrom).sort()[0], until: addDays(dates[dates.length - 1], fwd) }
}

// The one place a CSV row becomes a row to check (CD-F3): the booking route and Analyse
// (lib/matcher.ts findCsvDuplicates) build theirs only here, so both look at the same
// days. `row` is checked on its bank date and its day of payment; `windowRows` are what
// bookamat must be read for: the row, and the Buchungsdatum it books when that is another
// day near the bank date (the booking route checks that day in a second pass).
export function bankRows(tx: EasybankTransaction, o: {
  kind: 'expense' | 'income'; bookedDate: string; title?: string | null; titles?: readonly string[] | null; invoiceKey?: string | null
}): { row: PaymentRow; windowRows: Pick<PaymentRow, 'date' | 'payDate' | 'income' | 'direction'>[] } {
  const income = o.kind === 'income'
  const row: PaymentRow = {
    date: tx.date,
    payDate: payDay(tx, o.kind).payDate,
    amount: tx.amount,
    netAmount: o.kind === 'expense' ? tx.net_amount ?? null : undefined,
    income,
    title: o.title ?? null,
    // Only a row whose Buchungsregeln tie has them
    ...(o.titles?.length ? { titles: [...o.titles] } : {}),
    invoiceKey: o.invoiceKey ?? null,
    direction: 'back',
  }
  const windowRows: Pick<PaymentRow, 'date' | 'payDate' | 'income' | 'direction'>[] = [row]
  if (o.bookedDate !== tx.date && o.bookedDate !== row.payDate && nearBankDate(tx.date, o.bookedDate)) {
    windowRows.push({ date: o.bookedDate, income, direction: 'back' })
  }
  return { row, windowRows }
}

// The calendar years a window spans: bookamat keeps one set of books per year.
export function yearsOf(w: { from: string; until: string }): number[] {
  const a = Number(w.from.slice(0, 4)), b = Number(w.until.slice(0, 4))
  const out: number[] = []
  for (let y = a; y <= b; y++) out.push(y)
  return out
}

// The past 12 months up to `today` (YYYY-MM-DD) and the years they touch, newest first:
// the few-shot examples are read from each year's books in turn. On 29.02. the window
// starts on 01.03. of the year before. A day that is no date spans no year.
export function pastYearWindow(today: string): { from: string; until: string; years: number[] } {
  const d = new Date(`${today}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== today) {
    return { from: today, until: today, years: [] }
  }
  d.setUTCFullYear(d.getUTCFullYear() - 1)
  const from = d.toISOString().slice(0, 10)
  return { from, until: today, years: yearsOf({ from, until: today }).reverse() }
}
