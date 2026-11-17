import type { BookamatAccount, BookingPayload, MatchedIncomeTransaction, MatchedTransaction } from '@/lib/expenses/types'
import { lineDefaults, resolveExpenseDefaults, resolveIncomeDefaults, type AccountLookup } from './row-defaults'
import { csvBankAccountId } from './bank-account'
import { bookingDateOf } from './booking-dates'
import { keineVorsteuerOf } from './tax-accounts'

// ─── Build bookamat booking payload from matched transaction ──────────────────
//
// Single resolver for both booking sources: a known vendor rule (matched.vendor)
// or an AI/manual classification (matched.ai_suggested + UI overrides). Both
// produce the same BookingPayload shape — vendor fields and ai_suggested fields
// are just two different default sources, with flat string overrides from the
// UI always taking precedence field-by-field.

// What the builders need from bookamat's account lists: the Steuerkonto names
// (Bewirtung is recognised by its account), the CSV's own bank account
// (lib/bank-account.ts, the default for any row that has none), each account's
// locked BA values, and the zero-rate tax accounts. The booking route and the review
// page build it with payloadContext from the same lists, so both get one payload.
export type PayloadContext = {
  costAccountName?: (id: number) => string | undefined
  csvBankId?: number
  costAccount?: AccountLookup     // Steuerkonten (expenses)
  revenueAccount?: AccountLookup  // Ertragskonten (income)
  // bookamat requires a tax account on every line, a 0 % one too: „Keine Vorsteuer“
  // on an expense, „Keine Umsatzsteuer“ on income
  keineVorsteuerId?: number
  keineUmsatzsteuerId?: number
}

export type AccountLists = {
  cost_accounts?: BookamatAccount[] | null
  revenue_accounts?: BookamatAccount[] | null
  purchasetax_accounts?: BookamatAccount[] | null
  bank_accounts?: BookamatAccount[] | null
}

export function payloadContext(lists: AccountLists | null | undefined): PayloadContext {
  const byId = (list?: BookamatAccount[] | null) => {
    const m = new Map((list ?? []).map(a => [a.id, a]))
    return (id: number) => m.get(id)
  }
  const cost = byId(lists?.cost_accounts)
  const pt = lists?.purchasetax_accounts ?? []
  return {
    costAccountName: id => cost(id)?.name,
    csvBankId: csvBankAccountId(lists?.bank_accounts),
    costAccount: cost,
    revenueAccount: byId(lists?.revenue_accounts),
    keineVorsteuerId: keineVorsteuerOf(pt)?.id,
    keineUmsatzsteuerId: pt.find(a => /keine\s*umsatzsteuer/i.test(a.name))?.id,
  }
}

const isDomestic = (c: string | null | undefined) => !c || c.trim().toUpperCase() === 'AT'
const pct = (n: number) => Number(n).toFixed(2)

// The Rechnungsdatum an expense row books: the owner's, else the one read from the
// receipt attached by hand, else the one read from the receipt Analyse found — none once
// the owner removed that receipt (`gmailCleared`). The import page builds the row's
// receipt date with it (buildExpense, no override), the payload adds the owner's, and the
// ticks on a receipt upload test the same date: a row is never ticked by a Rechnungsdatum
// it does not book.
export function rowInvoiceDate(
  override: string | null | undefined,
  assignedDate: string | null | undefined,
  foundDate: string | null | undefined,
  gmailCleared: boolean,
): string | null {
  return override || (assignedDate ?? (gmailCleared ? null : foundDate)) || null
}

export function buildExpenseBookingPayload(
  matched: MatchedTransaction,
  override?: Record<string, string>,
  ctx: PayloadContext = {}
): BookingPayload {
  const ov = override || {}
  const ai = matched.ai_suggested

  // The title the row shows (matched.title — the rule's template, or the AI's title,
  // kept in step when a receipt re-classifies the row); the AI's only if it is empty.
  // A draft saved before that showed one title and booked another.
  const defaultTitle = matched.title || ai?.title || matched.transaction.counterparty
  const defaultDescription = matched.transaction.reference ? matched.transaction.reference.slice(0, 500) : ''

  // The same resolver the review row uses (lib/row-defaults.ts), so what the row
  // shows is what bookamat receives — accounts, VAT, both BA percentages, UID, country.
  const d = resolveExpenseDefaults(matched, ov, ctx.costAccountName, ctx.csvBankId ?? 0, ctx.costAccount)

  // A 0 % line needs a tax account too („Keine Vorsteuer“). On a single line only for
  // a domestic booking: a foreign 0 % is usually a missed reverse charge, and the row
  // then says „Vorsteuerkonto fehlt“ instead of booking it as no Vorsteuer.
  const single = {
    bankaccount: d.bankAccountId,
    costaccount: d.costAccountId,
    purchasetaxaccount: d.purchasetaxAccountId
      || (d.taxPercent === 0 && isDomestic(d.country) ? ctx.keineVorsteuerId : undefined),
    amount: matched.transaction.amount.toFixed(2),
    tax_percent: pct(d.taxPercent),
    deductibility_tax_percent: pct(d.deductTaxPercent),
    deductibility_amount_percent: pct(d.deductAmountPercent),
    country_dep: '',
    country_rec: '',
  }

  // A split (restaurant VAT rates, goods + bank fee, or the owner's own lines): one
  // line each, on the line's own accounts or the row's. A 0 % line without its own tax
  // account books „Keine Vorsteuer“ when that is what the row books anyway, or the row
  // is domestic — as a single line does. On a foreign row it keeps the row's account:
  // a reverse charge at 0 % or a missing Vorsteuerkonto is then reported, not booked as
  // no Vorsteuer. (The generated Trinkgeld and Bankspesen lines name their own.)
  const zeroRateAccount = d.purchasetaxAccountId === ctx.keineVorsteuerId || isDomestic(d.country)
    ? ctx.keineVorsteuerId
    : (d.purchasetaxAccountId || undefined)
  const amounts = matched.booking_lines?.length
    ? matched.booking_lines.map(line => {
        const ld = lineDefaults(line, d, ctx.costAccountName, ctx.costAccount)
        const rate = Number(line.vat_percent) || 0
        return {
          bankaccount: line.bank_account_id ?? d.bankAccountId,
          costaccount: line.cost_account_id ?? d.costAccountId,
          purchasetaxaccount: line.purchasetax_account_id
            ?? (rate > 0 ? (d.purchasetaxAccountId || undefined) : zeroRateAccount),
          amount: Number(line.amount_gross).toFixed(2),
          tax_percent: pct(rate),
          deductibility_tax_percent: pct(ld.deductTaxPercent),
          deductibility_amount_percent: pct(ld.deductAmountPercent),
          country_dep: '',
          country_rec: '',
        }
      })
    : [single]

  return {
    title: (ov['title'] || defaultTitle).slice(0, 50),
    // The Buchungsdatum the row shows and lets the owner change; without one, the day of
    // payment when it lies in an earlier month (lib/booking-dates.ts): a 30.12. card
    // payment posted 04.01. is booked on 30.12.; so is a transfer valued 31.12.
    date: bookingDateOf(matched.transaction, ov, 'expense'),
    // The row carries its receipt's date as the page resolved it (rowInvoiceDate)
    date_invoice: rowInvoiceDate(ov['date_invoice'], matched.extracted_invoice_date, null, false),
    date_delivery: ov['date_delivery'] || null,
    amounts,
    vatin: d.vatin,
    country: d.country,
    description: ov['description'] || defaultDescription,
  }
}

// Income counterpart: same override-precedence pattern, but on revenue/vat
// accounts instead of cost/purchasetax accounts (bookamat's income bookings
// use a structurally different account pair).
export function buildIncomeBookingPayload(
  matched: MatchedIncomeTransaction,
  override?: Record<string, string>,
  ctx: PayloadContext = {}
): BookingPayload {
  const ov = override || {}
  // The same resolver the income row uses (lib/row-defaults.ts): a field the owner
  // cleared stays cleared; the bank account is the CSV's own.
  const d = resolveIncomeDefaults(matched, ov, ctx.csvBankId ?? 0, ctx.revenueAccount)

  return {
    // Use the same title the review row / preview shows (matched.title — the
    // established "RN_<Nr> - <Name>" format). matched.title already falls back to
    // the AI title when there's no invoice number, so ai.title must NOT jump the
    // queue here: doing so booked a different, unformatted title than the preview.
    title: (ov['title'] || matched.title || matched.transaction.counterparty).slice(0, 50),
    // A credit valued in the month before the posting keeps that day (lib/booking-dates.ts)
    date: bookingDateOf(matched.transaction, ov, 'income'),
    date_invoice: ov['date_invoice'] || matched.extracted_invoice_date || null,
    amounts: [
      {
        // The CSV's own account (lib/bank-account.ts), as the row shows it. Without an
        // AI suggestion (a manually chosen Ertragskonto) this used to send bank 0.
        bankaccount: d.bankAccountId,
        costaccount: d.revenueAccountId,
        // 0 %-USt income (reverse charge, export, a Privateinlage) → „Keine Umsatzsteuer“,
        // for a domestic booking; a foreign one without a USt-Konto is left to the owner
        purchasetaxaccount: d.vatAccountId
          || (d.vatPercent === 0 && isDomestic(d.country) ? ctx.keineUmsatzsteuerId : undefined),
        amount: matched.transaction.amount.toFixed(2),
        tax_percent: String(d.vatPercent),
        // 100 / 100 unless the Ertragskonto locks them (Privateinlagen 0 / 0)
        deductibility_tax_percent: pct(d.deductTaxPercent),
        deductibility_amount_percent: pct(d.deductAmountPercent),
        country_dep: '',
        country_rec: '',
      },
    ],
    vatin: d.vatin,
    country: d.country,
    description: ov['description'] || [
      matched.extracted_invoice_number ? `Rechnung ${matched.extracted_invoice_number}` : '',
      matched.transaction.reference || '',
    ].filter(Boolean).join(' | ').slice(0, 500),
  }
}
