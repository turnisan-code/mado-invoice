// The day a bank row was paid, and the Buchungsdatum that follows from it (PR 4b).
// easybank posts a card payment of 29.–31.12. on the next bank day in January, and an
// instant transfer sent on a Sunday or after the cut-off on the next bank day too.
// Booked on the posting date, such a payment lands in the wrong year for income tax and
// in the wrong UVA quarter. The card stamp in the bank text, else the Valutadatum, says
// when the money moved. The card stamp also names the amount of a payment made in another
// currency (cardForeignAmount), which a receipt in that currency can be compared with.
//
// Pure and client-safe: the import page, the booking route, lib/booking-payload.ts and
// lib/matcher.ts all call it. Strings and Date.UTC only, never the local time zone
// (viennaDate names Europe/Vienna itself). Env-free, so the Belege modules can share it.
import { taxAccountSide, type TaxAccountLike } from './tax-accounts'

type TxLike = { date: string; reference?: string | null; raw?: Record<string, string> | null }

const ISO = /^\d{4}-\d{2}-\d{2}$/
// easybank's card reference („MC/000000901“): the row is a card payment
const CARD_REF = /\bMC\/\d{6,}/
// The card stamp after it: „dd.mm.“ and „hh:mm“ („POS 4711 D002 28.05. 09:15“). No check
// after the time: a merchant can start with a digit („…18:05|1A SHOP“).
const CARD_STAMP = /(?<![\d.])(\d{2})\.(\d{2})\.\s+\d{2}:\d{2}/
// A stamp further back than this is not the row's own: unreadable
const MAX_CARD_LAG_DAYS = 31
// A Valutadatum this many days before the posting date at most is the day of payment
const MAX_VALUTA_LAG_DAYS = 7
const VALUTA = /^(\d{2})\.(\d{2})\.(\d{4})$/
// Paid 01.–15.01.: the window of § 19 Abs 2 EStG
const FIRST_FIFTEEN = /^\d{4}-01-(0[1-9]|1[0-5])$/

const isoOf = (y: number, m: number, d: number): string | null => {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
    ? t.toISOString().slice(0, 10) : null
}
// A real date in ISO form („2026-02-30“ is not)
const realIso = (s: string | null | undefined): s is string =>
  !!s && ISO.test(s) && isoOf(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))) === s
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

// dd.mm.yyyy for a valid ISO date, else as given
export const deDate = (iso: string) => (ISO.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso)

// The calendar day of `d` in Vienna, YYYY-MM-DD. Throws for an invalid date.
export function viennaDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const part = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export type PayDay = {
  bankDate: string                 // col2, the posting date (tx.date)
  payDate: string | null           // the day the money moved, when earlier than the posting date and known
  source: 'card' | 'valuta' | null
  card: boolean                    // an „MC/…“ row
  stampUnreadable: boolean         // an MC row without a usable card stamp
}

// The card stamp's date, or null when there is none or it is unusable: not a real date,
// or more than MAX_CARD_LAG_DAYS before the posting date
function cardStamp(fromRef: string, bankDate: string): string | null {
  // „|“ is easybank's line break at 57 characters, not a separator: join the lines
  const m = fromRef.replace(/\|/g, '').match(CARD_STAMP)
  if (!m) return null
  const dd = Number(m[1]), mm = Number(m[2]), y = Number(bankDate.slice(0, 4))
  let iso = isoOf(y, mm, dd)
  // A December stamp on a January posting is the year before
  if (iso && iso > bankDate) iso = isoOf(y - 1, mm, dd)
  return iso && days(iso, bankDate) <= MAX_CARD_LAG_DAYS ? iso : null
}

// The Valutadatum (col3, „dd.mm.yyyy“) when it is a real date 1–7 days before the posting
// date: an instant transfer sent on 31.12. and posted on 04.01. was paid on 31.12.
function valutaDate(col3: string | null | undefined, bankDate: string): string | null {
  const m = (col3 ?? '').trim().match(VALUTA)
  const iso = m ? isoOf(Number(m[3]), Number(m[2]), Number(m[1])) : null
  if (!iso) return null
  const lag = days(iso, bankDate)
  return lag >= 1 && lag <= MAX_VALUTA_LAG_DAYS ? iso : null
}

// When the money of a bank row moved. A card row is paid on its card stamp: that wins over
// the Valutadatum, and a stamp on the posting day itself leaves nothing to move. Without a
// usable stamp, or on any other row, the Valutadatum 1–7 days before the posting date.
// Income takes only the Valutadatum of a non-card row: a card credit is a refund, which
// is never booked here.
export function payDay(tx: TxLike, kind: 'expense' | 'income' = 'expense'): PayDay {
  const bankDate = tx.date
  const text = tx.raw?.col1 ?? tx.reference ?? ''
  const at = text.search(CARD_REF)
  const card = at >= 0
  const posted = realIso(bankDate)
  const stamp = card && posted ? cardStamp(text.slice(at), bankDate) : null
  const valuta = posted ? valutaDate(tx.raw?.col3, bankDate) : null
  let payDate: string | null = null
  let source: PayDay['source'] = null
  if (kind === 'income') {
    if (!card && valuta) { payDate = valuta; source = 'valuta' }
  } else if (stamp) {
    if (stamp < bankDate) { payDate = stamp; source = 'card' }
  } else if (valuta) {
    payDate = valuta; source = 'valuta'
  }
  return { bankDate, payDate, source, card, stampUnreadable: card && !stamp }
}

// The Buchungsdatum a row books unless the owner sets one: the day of payment when it
// lies in an earlier month than the posting date — so always across the year boundary —
// else the posting date. Within a month the year and the UVA month are the same.
export function defaultBookingDate(tx: TxLike, kind: 'expense' | 'income' = 'expense'): string {
  const p = payDay(tx, kind)
  return p.payDate && p.payDate.slice(0, 7) < tx.date.slice(0, 7) ? p.payDate : tx.date
}

// The Buchungsdatum that is booked: the owner's, else the default
export function bookingDateOf(tx: TxLike, override?: Record<string, string> | null, kind: 'expense' | 'income' = 'expense'): string {
  return override?.date || defaultBookingDate(tx, kind)
}

// The row's chip when it books its day of payment
export const payDayLabel = (p: PayDay | null | undefined): string | null =>
  !p?.payDate ? null
    : p.source === 'card' ? `Kartenzahlung ${deDate(p.payDate)} · Bank ${deDate(p.bankDate)}`
    : `Valuta ${deDate(p.payDate)} · Bank ${deDate(p.bankDate)}`

// ─── The card stamp's foreign amount ──────────────────────────────────────────
// The card stamp, on the line after the card reference, starts with „POS“ or „E-COMM“, the
// amount the merchant charged and a code: „POS          123,40 GBP K002 05.07. 10:51“ was
// paid in pounds, and the debit is that amount in euros, with its SPESEN. A numeric code is
// the merchant's country („E-COMM        13,37 276 D002 …“, Germany): the amount is in
// euros.
const STAMP_AMOUNT = /^\s*(?:POS|E-COMM)\s+((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})\s+([A-Z]{3})(?![A-Za-z\d])/

// The amount and currency of a card payment made in another currency than euros (GBP, USD,
// CHF …), as its card stamp says; null for a euro row, a stamp without an amount, or a row
// that is no card payment. From col1, else the reference, with „|“ removed (easybank's line
// break, which can fall inside the stamp).
export function cardForeignAmount(tx: Pick<TxLike, 'reference' | 'raw'>): { amount: number; currency: string } | null {
  const text = (tx.raw?.col1 ?? tx.reference ?? '').replace(/\|/g, '')
  const ref = CARD_REF.exec(text)
  const m = ref ? STAMP_AMOUNT.exec(text.slice(ref.index + ref[0].length)) : null
  if (!m || m[2] === 'EUR') return null
  const amount = Number(m[1].replace(/\./g, '').replace(',', '.'))
  return amount > 0 ? { amount, currency: m[2] } : null
}

// ─── 15-Tage-Regel (§ 19 Abs 2 EStG) ──────────────────────────────────────────
// Regularly recurring payments made within 15 days of the turn of the year count for
// income tax in the year they belong to. Only income tax: an Ist-Versteuerer deducts
// domestic Vorsteuer in the month of payment, and a bookamat booking has one date.

// The day the rule asks about: the day of payment when it is known (payDay's card date or
// Valutadatum: a card payment of 15.01. posted on 18.01. keeps the bank date as its
// Buchungsdatum), else the Buchungsdatum. None once the Buchungsdatum lies in an earlier
// year than that day: the row was moved to 31.12., the question is answered.
function fifteenDayPaid(bookedDate: string, payDate?: string | null): string | null {
  if (!realIso(bookedDate)) return null
  const paid = realIso(payDate) ? payDate : bookedDate
  return bookedDate.slice(0, 4) < paid.slice(0, 4) ? null : paid
}

// The date-only superset of fifteenDayHint, for where the account lists or the new
// payload are not known yet: paid 01.–15.01. of Y, and the Rechnungsdatum is missing or
// invalid, in December of Y−1, or between 01.01. of Y and the payment. `payDate`: the
// row's day of payment (payDay), when known.
export function fifteenDayLoose(bookedDate: string, invoiceDate: string | null | undefined, payDate?: string | null): boolean {
  const paid = fifteenDayPaid(bookedDate, payDate)
  if (!paid || !FIRST_FIFTEEN.test(paid)) return false
  const y = Number(paid.slice(0, 4))
  if (!realIso(invoiceDate)) return true
  return invoiceDate.startsWith(`${y - 1}-12-`) || (invoiceDate >= `${y}-01-01` && invoiceDate <= paid)
}

export type FifteenDayHint = { message: string; moveTo: string | null }
type PayloadLike = { date: string; date_invoice: string | null; amounts: { purchasetaxaccount?: number; tax_percent: string }[] }
// Reverse charge: a purchase-side „IG Erwerb …“ / „Drittland Erwerb …“ account
const RC = /^(ig|drittland)\s*erwerb/i

// The 15-day question for an expense paid 01.–15.01., or null. A row with domestic tax is
// asked only for a December invoice, and never moved here. A row of reverse charge or 0 %
// only is asked for a December invoice, and for none or one of January before the payment
// (a Google bill for December carries a January date); the button moves it to 31.12. of
// the year before, but only while that year is still the one set: after the switch it is
// booked by hand in bookamat. Paid: on `payDate` (the row's day of payment, payDay) when
// known, else on the Buchungsdatum.
export function fifteenDayHint(
  p: PayloadLike,
  taxAccount: (id: number) => TaxAccountLike | undefined,
  configuredYear?: number,
  payDate?: string | null,
): FifteenDayHint | null {
  const paid = fifteenDayPaid(p.date, payDate)
  if (!paid || !FIRST_FIFTEEN.test(paid) || !p.amounts?.length) return null
  const y = Number(paid.slice(0, 4))
  const prev = y - 1
  const inv = realIso(p.date_invoice) ? p.date_invoice : null
  const dec = !!inv && inv.startsWith(`${prev}-12-`)
  const early = !inv || (inv >= `${y}-01-01` && inv <= paid)
  const kinds = p.amounts.map(a => {
    const acc = taxAccount(Number(a.purchasetaxaccount) || 0)
    if (acc && taxAccountSide(acc) === 'purchase' && RC.test(acc.name.trim())) return 'rc'
    if (Number(a.tax_percent) === 0) return 'zero'
    return 'domestic'
  })
  const head = inv
    ? `15-Tage-Regel? Rechnung vom ${deDate(inv)}, bezahlt am ${deDate(paid)}.`
    : `15-Tage-Regel? Kein Rechnungsdatum, bezahlt am ${deDate(paid)}.`
  if (kinds.includes('domestic')) {
    return dec
      ? { moveTo: null, message: `${head} Ist das eine regelmäßige Zahlung für Dezember, zählt sie für die Einkommensteuer zu ${prev} (§ 19 EStG), die Vorsteuer aber zum Jänner ${y} (Ist-Versteuerung) — hier nicht verschieben, mit dem Steuerberater klären.` }
      : null
  }
  if (!dec && !early) return null
  const question = dec
    ? ` Ist das eine regelmäßige Zahlung für Dezember (z. B. ein Abo), zählt sie für die Einkommensteuer noch zu ${prev} (§ 19 EStG);`
    : ` Rechnet sie den Dezember ab (regelmäßig, im Nachhinein — z. B. Google), zählt sie für die Einkommensteuer noch zu ${prev} (§ 19 EStG);`
  const tail = kinds.includes('rc')
    ? ' die Reverse-Charge-Steuer gehört ohnehin in den Monat der Leistung.'
    : ' Umsatzsteuer ist keine dabei.'
  // After the switch the year before cannot be booked here
  if (configuredYear != null && configuredYear !== prev) {
    return {
      moveTo: null,
      message: dec
        ? `${head}${question}${tail} Buchungsjahr ist schon ${configuredYear}: in bookamat ${prev} von Hand auf 31.12.${prev} buchen (falls noch nicht geschehen) und hier nicht ankreuzen — auch nicht bei einem späteren Import.`
        : `${head}${question}${tail} Dann: Buchungsjahr ist schon ${configuredYear} — in bookamat ${prev} von Hand auf 31.12.${prev} buchen (falls noch nicht geschehen) und hier nicht ankreuzen, auch nicht bei einem späteren Import. Gilt sie für Jänner (im Voraus bezahlt): wie üblich ankreuzen.`,
    }
  }
  return {
    // The year set unknown: asked all the same, but nothing is moved
    moveTo: configuredYear === prev ? `${prev}-12-31` : null,
    message: `${head}${question}${tail}${dec ? '' : ' Gilt sie für Jänner (im Voraus bezahlt), nichts ändern.'}`,
  }
}
