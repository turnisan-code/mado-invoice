import type { BookamatAccount, BookingPayload } from '@/lib/expenses/types'
import { locksOf } from './account-locks'
import { taxAccountSide } from './tax-accounts'
import { AT_VAT_RATES, EU_COUNTRY_CODES, allowedRates, countryFromVatin, normalizeCountry } from './vat-origin'
import { isOwnVatin } from './vatin'
import { eur } from './money'
import type { PayDay } from './booking-dates'

// What bookamat would refuse, or what would book wrong, checked against bookamat's own
// account lists before anything is sent (audit P1-2). The review row shows these, the
// Testlauf lists them, and the booking route books nothing that has a blocking one.
// Each message says what to change, in the words of the bookamat screen.
//
// Pure: the import page runs it in the browser on every row, the route on the payload
// it is about to send.

export type BookingProblem = {
  line?: number        // 0-based line of a split; unset = the booking as a whole
  message: string
  blocking: boolean    // false = shown, but booked as it is
}

export type ValidationLists = {
  cost_accounts?: BookamatAccount[] | null
  revenue_accounts?: BookamatAccount[] | null
  purchasetax_accounts?: BookamatAccount[] | null
  bank_accounts?: BookamatAccount[] | null
}

export type ValidationOptions = {
  // The bank amount the lines must add up to
  expectedTotal?: number
  // bookamat's configured year: every booking is posted into that year's books
  year?: number
  // A CSV row's day of payment (lib/booking-dates.ts payDay): the card date or the
  // Valutadatum before the bank date, and whether a card row's stamp was unreadable
  pay?: PayDay | null
}

const pctText = (n: number) => `${String(Math.round(n * 100) / 100).replace('.', ',')} %`
const q = (name: string) => `„${name}“`
const isoDate = /^\d{4}-\d{2}-\d{2}$/
const deDate = (d: string) => (isoDate.test(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : d)

// An index of a list, or null when the list is not known (not loaded): nothing is then
// checked against it, rather than every account reported as unknown.
const indexOf = (list?: BookamatAccount[] | null) =>
  list && list.length ? new Map(list.map(a => [Number(a.id), a])) : null

// The account an expense meant when it got a sales-side one, and the reverse for
// income; only suggested when the line's Steuerkonto allows it.
const PURCHASE_FOR_SALES: [RegExp, string][] = [
  [/^ig\s*lieferungen/i, 'IG Erwerb von Lieferungen'],
  [/^ig\s*leistungen/i, 'IG Erwerb von Leistungen'],
  [/^drittland\s*leistungen/i, 'Drittland Erwerb von Leistungen'],
  [/^umsatzsteuer\s*inland/i, 'Vorsteuer Inland'],
  [/^keine\s*umsatzsteuer/i, 'Keine Vorsteuer'],
]
const SALES_FOR_PURCHASE: [RegExp, string][] = [
  [/^vorsteuer\s*inland/i, 'Umsatzsteuer Inland'],
  [/^ig\s*erwerb\s*von\s*lieferungen/i, 'IG Lieferungen'],
  [/^ig\s*erwerb\s*von\s*leistungen/i, 'IG Leistungen'],
  [/^drittland\s*erwerb/i, 'Drittland Leistungen'],
  [/^keine\s*vorsteuer/i, 'Keine Umsatzsteuer'],
]

const IG_ERWERB = /\big\b.*erwerb|innergemeinschaftlich.*erwerb/i
const IG_SALE = /^ig\s*(lieferungen|leistungen)/i
// Accounts for which bookamat wants the invoice date (it fills in the payment date
// and says so when none is sent)
const NEEDS_INVOICE_DATE = /erwerb|einfuhr/i

// The USt-Satz a tax account takes. bookamat refuses any other („tax percent value is not
// allowed“): each tax account lists its rates (`tax_values`, read with lib/vat-origin.ts
// allowedRates; 2026: „Vorsteuer Inland“ 20, 13, 10, 4,9 — „IG Erwerb von Leistungen“
// 20, 13, 10 — „Keine Vorsteuer“ 0). A line is checked against that list when the year's
// list carries it, else against Austria's rates (AT_VAT_RATES: 20, 13, 10 and, since
// 1.7.2026, 4,9 %). A rate bookamat would take can still be wrong: German 19 % on
// „Vorsteuer Inland“ claims foreign VAT as Austrian Vorsteuer. Where the reason is known
// the text names it; else it says which rates the account takes.
const ZERO_ONLY = /^(keine\s*(vorsteuer|umsatzsteuer)|umsatzsteuerfrei|ums[aä]tze\s*§\s*19)/i
const DOMESTIC_RATE = /^(vorsteuer|umsatzsteuer)\s*inland/i
const REVERSE_CHARGE = /erwerb/i
const ZERO_RATED_SALE = /^(ig|drittland)\s*(lieferungen|leistungen)/i

// A UID with its whole number (decisions L3): ATU and 8 digits for an Austrian one; for any
// other two-letter prefix (XI and CHE included) at least 8 letters or digits after it, as
// lib/vat-origin.ts countryFromVatin counts an EU state's — Romania's from 2 digits.
// Spaces, dots, hyphens and case don't count. A bare prefix („ATU“, „DE“) or a half-typed
// number („ATU7“, „DE1234“) has none. A shape that is no prefix and number is not judged.
function hasUidNumber(raw: string): boolean {
  const v = raw.replace(/[\s.\-]/g, '').toUpperCase()
  if (!/\d/.test(v)) return false
  if (v.startsWith('AT')) return /^ATU\d{8}$/.test(v)
  const m = /^([A-Z]{2})([0-9A-Z]+)$/.exec(v)
  return !m || m[2].length >= (m[1] === 'RO' ? 2 : 8)
}

// An IG Lieferung or Leistung is one only for a customer in another EU state, and goes to
// the ZM under the customer's UID. A UID with its whole number (hasUidNumber) on „IG
// Leistungen/Lieferungen“ is still not that one when (the first that applies is said;
// blocking unless noted):
// 1. it is the owner's own (printed on every invoice, so read as the customer's);
// 2. it is Austrian: a customer in Austria is charged Austrian USt;
// 3. it has no country code;
// 4. its prefix is no other EU state (EL is Greece; XI, Northern Ireland, counts as EU for
//    goods only): GB, CHE, NO … are Drittland;
// 5. the Kundenland is another state than the UID's (XI aside): said, not blocking, as V1 —
//    the booking may be right.
// 3 to 5 read the UID's prefix, not countryFromVatin: no length per state and no VIES
// check, so Romania's short numbers pass, as hasUidNumber lets them.
function igSaleUidProblem(vatin: string, name: string, country: string): Omit<BookingProblem, 'line'> | null {
  const uid = vatin.replace(/[\s.\-]/g, '').toUpperCase()
  const services = /leistungen/i.test(name)
  if (isOwnVatin(vatin)) return { blocking: true, message: `${uid} ist deine eigene UID — die UID des Kunden eintragen.` }
  if (countryFromVatin(vatin) === 'AT') {
    return { blocking: true, message: `${q(name)} mit der österreichischen UID ${uid} — ein Kunde in Österreich ist keine ${services ? 'IG Leistung' : 'IG Lieferung'}: „Umsatzsteuer Inland“ mit dem österreichischen Satz wählen.` }
  }
  const prefix = /^[A-Z]{2}/.exec(uid)?.[0]
  if (!prefix) {
    return { blocking: true, message: `${q(name)}: die UID ${uid} hat keinen Ländercode — die UID des Kunden mit Ländercode eintragen (z. B. DE123456789).` }
  }
  const state = prefix === 'EL' ? 'GR' : prefix
  const xiGoods = state === 'XI' && !services
  if (!EU_COUNTRY_CODES.has(state) && !xiGoods) {
    return { blocking: true, message: `${q(name)} mit der UID ${uid} — der Kunde sitzt nicht in einem anderen EU-Staat: „${services ? 'Drittland Leistungen' : 'Drittland Lieferungen'}“ wählen.` }
  }
  if (!xiGoods && country !== state) {
    return { blocking: false, message: `Kundenland ${country || 'leer (Österreich)'}, die UID ${uid} ist aus ${state} — Kundenland auf ${state} setzen.` }
  }
  return null
}

// Rates compared in hundredths, as bookamat writes them („4.90“)
const hasRate = (rates: readonly number[], rate: number) =>
  rates.some(r => Math.round(r * 100) === Math.round(rate * 100))
// Rates as the texts list them, highest first: „20, 13, 10 oder 4,9 %“
function rateList(rates: readonly number[]): string {
  const t = [...rates].sort((a, b) => b - a).map(r => String(Math.round(r * 100) / 100).replace('.', ','))
  return `${t.length > 1 ? `${t.slice(0, -1).join(', ')} oder ${t[t.length - 1]}` : t.join('')} %`
}

function rateProblem(account: BookamatAccount, rate: number, income: boolean): string | null {
  const name = account.name.trim()
  const is = (re: RegExp) => re.test(name)
  const taxWord = income ? 'Umsatzsteuerkonto' : 'Vorsteuerkonto'
  // The rates bookamat takes on this account; null = not known (a list read without them,
  // or [""]: any rate, as on „Vorsteuer Rückforderung EU“)
  const allowed = allowedRates(account)
  const takes = (r: number) => hasRate(allowed ?? AT_VAT_RATES, r)
  // An Austrian rate this year's account does not take (4,9 % on „IG Erwerb von
  // Leistungen“), or a rate outside its list that no rule below explains
  const notTaken = (rates: readonly number[]) =>
    `${q(name)} wird mit ${rateList(rates)} gebucht, nicht mit ${pctText(rate)} — USt-Satz ändern oder ein anderes ${taxWord} wählen`
  if (is(ZERO_ONLY)) {
    return rate === 0 ? null : `${q(name)} wird mit 0 % gebucht — USt-Satz auf 0 % setzen oder ein ${taxWord} wählen`
  }
  if (is(DOMESTIC_RATE)) {
    if (rate === 0) return income
      ? `${q(name)} mit 0 % — bei 0 % USt „Keine Umsatzsteuer“ (Ausland: „IG Leistungen“ bzw. „Drittland Leistungen“) wählen`
      : `${q(name)} mit 0 % — bei 0 % USt „Keine Vorsteuer“ wählen`
    if (takes(rate)) return null
    if (allowed && hasRate(AT_VAT_RATES, rate)) return notTaken(allowed)
    return income
      ? `${pctText(rate)} ist kein österreichischer Steuersatz (${rateList(AT_VAT_RATES)})`
      : `${pctText(rate)} ist kein österreichischer Steuersatz — ausländische USt ist hier nicht abziehbar: mit 0 % auf „Keine Vorsteuer“ buchen`
  }
  if (!income && is(REVERSE_CHARGE)) {
    if (takes(rate)) return null
    if (allowed && hasRate(AT_VAT_RATES, rate)) return notTaken(allowed)
    return `Reverse Charge wird mit dem österreichischen Satz gebucht (meist 20 %), nicht mit ${pctText(rate)}`
  }
  if (income && is(ZERO_RATED_SALE) && rate !== 0) {
    return `${q(name)} wird mit 0 % gebucht — die Steuer schuldet der Kunde`
  }
  return allowed && !hasRate(allowed, rate) ? notTaken(allowed) : null
}

export function validatePayload(
  p: BookingPayload,
  kind: 'expense' | 'income',
  lists: ValidationLists | null | undefined,
  opts: ValidationOptions = {},
): BookingProblem[] {
  const out: BookingProblem[] = []
  const add = (message: string, blocking = true, line?: number) => out.push({ line, message, blocking })
  const income = kind === 'income'

  const banks = indexOf(lists?.bank_accounts)
  const costs = indexOf(lists?.cost_accounts)
  const revenues = indexOf(lists?.revenue_accounts)
  const taxes = indexOf(lists?.purchasetax_accounts)
  // The account list a line's Steuer-/Ertragskonto must come from, and the other one
  const own = income ? revenues : costs
  const other = income ? costs : revenues
  const accountWord = income ? 'Ertragskonto' : 'Steuerkonto'
  const taxWord = income ? 'Umsatzsteuerkonto' : 'Vorsteuerkonto'
  // Where an unknown account id is missing: the year's books (every account id differs
  // per year — an id of 2026 is in bookamat, but not in 2027), else bookamat (as
  // lib/rule-accounts.ts says it)
  const books = typeof opts.year === 'number' && Number.isInteger(opts.year) ? String(opts.year) : 'bookamat'

  if (!(p.title || '').trim()) add('Buchungstitel fehlt')
  if (!isoDate.test(p.date || '')) add('Buchungsdatum fehlt oder ist ungültig')
  else {
    const yp = bookingYearProblem(p.date, opts)
    if (yp) add(yp.message, yp.blocking)
  }
  // Booked on the bank date unless the owner looks: the card date was not found. Expenses
  // only: a card credit is a refund, never booked here.
  if (!income && opts.pay?.card && opts.pay.stampUnreadable) {
    add('Kartenzahlung ohne lesbares Kartendatum — Buchungsdatum prüfen: bezahlt ist am Tag der Kartenzahlung, nicht am Bankdatum', false)
  }
  if (!p.amounts?.length) {
    add('Keine Buchungszeile')
    return out
  }

  const country = normalizeCountry(p.country)
  const foreign = !!country && country !== 'AT'
  const usedTaxAccounts: BookamatAccount[] = []
  // Some line books „Vorsteuer Inland“ at a rate the account takes (V1 below)
  let inlandAtRate = false

  p.amounts.forEach((a, k) => {
    const line = (message: string, blocking = true) => add(message, blocking, k)

    // Zahlungsmittelkonto
    const bankId = Number(a.bankaccount) || 0
    if (!bankId) line('Zahlungsmittelkonto fehlt')
    else if (banks && !banks.has(bankId)) line(`Zahlungsmittelkonto #${bankId} gibt es in ${books} nicht — neu wählen`)

    // Steuer-/Ertragskonto
    const accountId = Number(a.costaccount) || 0
    const account = accountId ? own?.get(accountId) : undefined
    if (!accountId) line(`${accountWord} fehlt`)
    else if (own && !account) {
      const wrongKind = other?.get(accountId)
      if (wrongKind) {
        line(income
          ? `${q(wrongKind.name)} ist ein Aufwandskonto — für eine Einnahme ein Ertragskonto wählen`
          : `${q(wrongKind.name)} ist ein Ertragskonto — für eine Ausgabe ein Steuerkonto wählen`)
      } else line(`${accountWord} #${accountId} gibt es in ${books} nicht — neu wählen`)
    }

    // Vorsteuer-/Umsatzsteuerkonto: required on every line, the right side, and one
    // that bookamat allows with this Steuerkonto
    const taxId = Number(a.purchasetaxaccount) || 0
    const rate = Number(a.tax_percent)
    const taxAccount = taxId ? taxes?.get(taxId) : undefined
    if (!taxId) {
      if (income) {
        line(rate !== 0 ? `${taxWord} fehlt`
          : foreign ? `${taxWord} fehlt — Kunde in der EU mit UID: „IG Leistungen“ (UID eintragen); außerhalb der EU: „Drittland Leistungen“`
          : `${taxWord} fehlt — bei 0 % USt „Keine Umsatzsteuer“`)
      } else if (rate === 0 && foreign) {
        line('Vorsteuerkonto fehlt — Reverse Charge (Rechnung ohne USt)? Dann „IG Erwerb …“ bzw. „Drittland Erwerb von Leistungen“ mit 20 %; ausländische USt verrechnet? Dann „Keine Vorsteuer“ mit 0 %')
      } else line(rate === 0 ? 'Vorsteuerkonto fehlt — bei 0 % USt „Keine Vorsteuer“' : 'Vorsteuerkonto fehlt')
    } else if (taxes && !taxAccount) {
      line(`${taxWord} #${taxId} gibt es in ${books} nicht — neu wählen`)
    } else if (taxAccount) {
      usedTaxAccounts.push(taxAccount)
      const allowed = account?.purchasetaxaccounts ?? []
      const allowedHas = (name: string) => allowed.some(x => x.name.trim().toLowerCase() === name.toLowerCase())
      const side = taxAccountSide(taxAccount)
      if (!income && side === 'sales') {
        if (/^drittland\s*leistungen/i.test(taxAccount.name.trim())) {
          line(`${q(taxAccount.name)} ist ein Konto für eigene Verkäufe, nicht für eine Ausgabe — „Drittland Erwerb von Leistungen“ wählen (Reverse Charge, Rechnung ohne USt) oder „Keine Vorsteuer“ mit 0 % (ausländische USt verrechnet, Leistung im Ausland verbraucht)`)
        } else {
          const fit = PURCHASE_FOR_SALES.find(([re]) => re.test(taxAccount.name.trim()))?.[1]
          line(`${q(taxAccount.name)} ist ein Konto für eigene Verkäufe, nicht für eine Ausgabe — ${fit && (!allowed.length || allowedHas(fit)) ? `${q(fit)} wählen` : 'ein Vorsteuerkonto wählen'}`)
        }
      } else if (income && side === 'purchase') {
        const fit = SALES_FOR_PURCHASE.find(([re]) => re.test(taxAccount.name.trim()))?.[1]
        line(`${q(taxAccount.name)} ist ein Vorsteuerkonto, nicht für eine Einnahme — ${fit && (!allowed.length || allowedHas(fit)) ? `${q(fit)} wählen` : 'ein Umsatzsteuerkonto wählen'}`)
      } else if (account && allowed.length && !allowed.some(x => Number(x.id) === taxId)) {
        line(`${q(taxAccount.name)} ist mit dem ${accountWord} ${q(account.name)} nicht erlaubt — erlaubt: ${allowed.map(x => x.name).join(', ')}`)
      } else if (Number.isFinite(rate)) {
        const wrongRate = rateProblem(taxAccount, rate, income)
        if (wrongRate) line(wrongRate)
        else if (!income && rate > 0 && side === 'purchase' && DOMESTIC_RATE.test(taxAccount.name.trim())) inlandAtRate = true
      }
    }

    // Amount, rate, BA values
    const amount = Number(a.amount)
    if (!Number.isFinite(amount) || amount === 0) line('Betrag fehlt')
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) line('USt-Satz ungültig')
    for (const [field, label] of [['deductibility_tax_percent', 'BA USt'], ['deductibility_amount_percent', 'BA Betrag']] as const) {
      const raw = a[field]
      if (raw == null || raw === '') continue
      const v = Number(raw)
      if (!Number.isFinite(v) || v < 0 || v > 100) { line(`${label} ungültig`); continue }
      // A value the account locks is booked as locked, whatever is sent: a different
      // one means the row shows something other than what bookamat books
      const lock = account ? locksOf(account)[field === 'deductibility_tax_percent' ? 'tax' : 'amount'] : null
      if (lock != null && Math.abs(v - lock) > 0.001) {
        line(`${label}: ${q(account!.name)} gibt ${pctText(lock)} vor (gesendet ${pctText(v)})`)
      }
    }
  })

  // UID: bookamat refuses an IG Erwerb (and an IG Lieferung/Leistung) without one.
  // Drittland needs none. A UID without its whole number („ATU“, „ATU7“, „DE“: a hand
  // edit, an old draft, the AI's „DE1234“) is none either — it would pass this check as
  // filled in (and V2 below as not Austrian), and be booked as the supplier's or the
  // customer's UID.
  const vatin = (p.vatin || '').trim()
  if (!vatin || !hasUidNumber(vatin)) {
    const ig = usedTaxAccounts.find(t => (income ? IG_SALE : IG_ERWERB).test(t.name.trim()))
    if (ig) {
      add(income
        ? `${q(ig.name)} braucht die UID des Kunden — UID eintragen oder ein anderes Umsatzsteuerkonto wählen`
        : `${q(ig.name)} braucht die UID des Lieferanten (steht auf der Rechnung) — UID eintragen oder ein anderes Vorsteuerkonto wählen`)
    }
  } else if (income) {
    // Income on „IG Leistungen/Lieferungen“: the customer's UID of another EU state
    // (igSaleUidProblem). „Umsatzsteuer Inland“ and Drittland are not judged. Said once
    // for the booking.
    const ig = usedTaxAccounts.find(t => IG_SALE.test(t.name.trim()))
    const problem = ig ? igSaleUidProblem(vatin, ig.name.trim(), country) : null
    if (problem) add(problem.message, problem.blocking)
  } else {
    // V2 — reverse charge (IG/Drittland Erwerb) with an Austrian UID: an Austrian supplier
    // is never reverse charge (bookamat has no account for a domestic one), and the owner's
    // own UID is never the supplier's. Either one also gets an IG Erwerb past the check for
    // a missing UID above (Amazon EU S.à r.l. charges Austrian VAT under its ATU number;
    // the own UID was read as the supplier's on two bookings). Blocking: never
    // right here. Said once for the booking.
    const rc = usedTaxAccounts.find(t => taxAccountSide(t) === 'purchase' && REVERSE_CHARGE.test(t.name.trim()))
    const uid = vatin.replace(/[\s.\-]/g, '').toUpperCase()
    if (rc && isOwnVatin(vatin)) {
      add(`${uid} ist deine eigene UID — die UID des Lieferanten (steht auf der Rechnung) eintragen.`)
    } else if (rc && countryFromVatin(vatin) === 'AT') {
      add(`${q(rc.name)} mit der österreichischen UID ${uid} — ein österreichischer Lieferant ist kein Reverse Charge: weist der Beleg österreichische USt aus, „Vorsteuer Inland“ mit dem Satz vom Beleg wählen; sonst die ausländische UID des Lieferanten eintragen.`)
    }
  }

  // V1 — a foreign Herkunftsland on „Vorsteuer Inland“ at a rate the account takes (a
  // foreign rate is refused above already, so it is not said twice) without the supplier's
  // Austrian UID: foreign VAT is not Vorsteuer here, nor Austrian VAT a seller without an
  // ATU number charges (OSS). Shown, not blocking: the country may be read wrong, or the
  // supplier is registered in Austria and its ATU number is missing — the text says both.
  // The backstop for hand edits and Buchungsregeln; said once for the booking.
  if (!income && inlandAtRate && foreign && countryFromVatin(vatin) !== 'AT') {
    add(`Herkunftsland ${country} mit „Vorsteuer Inland“ — ausländische USt ist hier nicht abziehbar: „Keine Vorsteuer“ mit 0 % wählen. Verrechnet der Lieferant österreichische USt, seine UID (ATU…) eintragen.`, false)
  }

  // Rechnungsdatum: bookamat wants one for reverse-charge accounts; without it the
  // payment date is booked and reported afterwards
  if (!income && !p.date_invoice) {
    const rc = usedTaxAccounts.find(t => taxAccountSide(t) === 'purchase' && NEEDS_INVOICE_DATE.test(t.name))
    if (rc) add(`Rechnungsdatum fehlt — bookamat verlangt es für ${q(rc.name)}; sonst wird das Buchungsdatum eingesetzt`, false)
  }

  // A split must add up to what left the account
  if (opts.expectedTotal != null && p.amounts.length > 1) {
    const sum = Math.round(p.amounts.reduce((s, a) => s + (Number(a.amount) || 0), 0) * 100) / 100
    if (Math.abs(sum - opts.expectedTotal) > 0.02) {
      add(`Die Zeilen ergeben ${eur(sum)}, abgebucht wurden ${eur(opts.expectedTotal)} — Aufteilung anpassen`)
    }
  }

  return collapseLines(out, p.amounts.length)
}

// The same problem on every line of a split is said once; one on some lines names them.
function collapseLines(problems: BookingProblem[], lineCount: number): BookingProblem[] {
  if (lineCount < 2) return problems.map(pr => ({ ...pr, line: undefined }))
  const byMessage = new Map<string, BookingProblem[]>()
  for (const pr of problems) {
    if (pr.line == null) continue
    const list = byMessage.get(pr.message) ?? []
    list.push(pr)
    byMessage.set(pr.message, list)
  }
  const out: BookingProblem[] = []
  const said = new Set<string>()
  for (const pr of problems) {
    if (pr.line == null) { out.push(pr); continue }
    const same = byMessage.get(pr.message)!
    if (same.length === lineCount) {
      if (!said.has(pr.message)) { said.add(pr.message); out.push({ message: pr.message, blocking: pr.blocking }) }
      continue
    }
    out.push({ ...pr, message: `Zeile ${pr.line + 1}: ${pr.message}` })
  }
  return out
}

// The year a booking goes into, said by direction. A payment of an earlier year is never
// told to wait for the switch or to change its date: moved into the open year it is
// booked in the wrong year, and twice (its booking there is outside the duplicate check's
// window). A later year waits for the switch. A row's day of payment — its card date or
// Valutadatum — is named when it lies in the Buchungsdatum's year, and a Buchungsdatum
// moved into a later year than that day is refused (A2): typing the bank date would book
// a December payment into January. The other way (a 15-day move to 31.12.) is allowed.
export function bookingYearProblem(date: string, opts: Pick<ValidationOptions, 'year' | 'pay'>): BookingProblem | null {
  if (!isoDate.test(date || '')) return null
  const y = Number(date.slice(0, 4))
  const pay = opts.pay?.payDate && opts.pay.source ? opts.pay : null
  const P = pay?.payDate ?? ''
  const py = pay ? Number(P.slice(0, 4)) : null
  if (pay && py! < y) {
    return {
      blocking: true,
      message: pay.source === 'card'
        ? `Kartenzahlung vom ${deDate(P)} gehört ins Jahr ${py} — Buchungsdatum ${deDate(date)} liegt in ${y}: Buchungsdatum auf ${deDate(P)} setzen`
        : `Zahlung vom ${deDate(P)} (Valuta) gehört ins Jahr ${py} — Buchungsdatum ${deDate(date)} liegt in ${y}: Buchungsdatum auf ${deDate(P)} setzen`,
    }
  }
  if (!opts.year || y === opts.year) return null
  const what = !pay || py !== y ? `Buchungsdatum ${deDate(date)}`
    : pay.source === 'card'
      ? `Kartenzahlung vom ${deDate(P)}${pay.bankDate !== P ? ` (Bank ${deDate(pay.bankDate)})` : ''}`
      : `Zahlung vom ${deDate(P)} (Valuta, Bank ${deDate(pay.bankDate)})`
  return {
    blocking: true,
    message: y < opts.year
      ? `${what} liegt nicht im Buchungsjahr ${opts.year} — direkt in bookamat im Jahr ${y} buchen`
      : `${what} liegt nicht im Buchungsjahr ${opts.year} — erst nach der Umstellung auf ${y} hier buchen (Einstellungen → Buchungsjahr)`,
  }
}

export const blockingProblems = (problems: BookingProblem[] | null | undefined) =>
  (problems ?? []).filter(p => p.blocking)

// What blocks a Buchungsregel's row, said for the rule: an account the year's books do
// not have („… gibt es in 2027 nicht“) is the rule's, written in another year. Picked
// anew on the row only, the next import says it again. A rate that is no Austrian one is
// the rule's when the row books the rule's rate (`ruleRate`: no rate of its own) — a rule
// saved at a rate Supabase rounded (5 for 4,9): the rule's rate is to be checked, not its
// Vorsteuer booked away as foreign VAT.
export function ruleBlockText(block: string | null, ruleName: string | null | undefined, ruleRate = true): string | null {
  if (!block || !ruleName) return block
  if (/gibt es in \d{4} nicht/.test(block)) return `${block} — Buchungsregel „${ruleName}“ unter Buchungsregeln neu wählen`
  const notAustrian = ruleRate ? /^(.+?) ist kein österreichischer Steuersatz/.exec(block) : null
  return notAustrian
    ? `${notAustrian[1]} ist kein österreichischer Steuersatz (${rateList(AT_VAT_RATES)}) — USt-Satz der Buchungsregel „${ruleName}“ unter Buchungsregeln prüfen`
    : block
}

// A Buchungsregel's row's problems as its block says them (ruleBlockText, each blocking one):
// the row and its details list what the checkbox and the result screen say (review check
// RULES-3)
export const ruleProblems = (problems: BookingProblem[], ruleName: string | null | undefined, ruleRate = true): BookingProblem[] =>
  !ruleName ? problems : problems.map(p => (p.blocking ? { ...p, message: ruleBlockText(p.message, ruleName, ruleRate) ?? p.message } : p))

// One line per problem, for an error row or a list
export const problemText = (problems: BookingProblem[]) => problems.map(p => p.message).join('\n')
