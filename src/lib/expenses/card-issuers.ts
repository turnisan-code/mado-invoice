// Credit card issuers in the bank CSV (PR „Vorsteuer“, fixed rules): who debits the
// business account for a card's monthly settlement („PAYLIFE ABRECHNUNG VOM 18.10.2026 …
// PayLife“), and who pays a card's credit balance back to it.
//
// A leaf module: lib/card-settlement.ts (debits) and lib/refunds.ts (credits) share this
// one table without importing each other. Pure and client-safe: it imports only
// lib/own-transfer.ts and reads no env variable.
import { findCounterpartyAccount } from './own-transfer'

// Card issuers as banks print them in a SEPA debit or credit: the holder of the
// counterparty account („BAWAATWWXXX AT… PayLife“), or the bank text („DINERS CLUB
// ABRECHNUNG 10/2026“). `where`: where the issuer keeps its statements — not the mailbox.
export const CARD_ISSUERS = [
  { issuer: 'PayLife', pattern: /\bpay\s*life\b/i, where: 'im PayLife Serviceportal' },
  { issuer: 'card complete', pattern: /\bcard\s*complete\b/i, where: 'im Kundenportal von card complete' },
  { issuer: 'Diners Club', pattern: /\bdiners\s*club\b|\bdc\s*bank\b/i, where: 'im Kundenportal von Diners Club' },
  { issuer: 'American Express', pattern: /\bamerican\s*express\b|\bamex\b/i, where: 'im Kundenportal von American Express' },
] as const

// `by`: found as the counterparty account's holder, or only in the bank text
export type CardIssuer = { issuer: string; where: string; by: 'holder' | 'text' }

// What the row's bank text is read from: column 1 of the CSV, else the reference (a
// draft's row), and the parser's counterparty
export type IssuerText = {
  counterparty?: string | null
  reference?: string | null
  raw?: Record<string, string> | null
}

// The issuer a row names: by the counterparty account's holder first, else by the text.
// Callers rule out card rows first (MC/… E-COMM|POS): there an issuer is a merchant
// („AMEX TRAVEL“). Never throws: odd input names none.
export function cardIssuerOf(tx: IssuerText | null | undefined): CardIssuer | null {
  try {
    if (!tx) return null
    const col1 = tx.raw?.col1
    const bankText = typeof col1 === 'string' ? col1 : (typeof tx.reference === 'string' ? tx.reference : '')
    const col0 = tx.raw?.col0
    const holder = findCounterpartyAccount(bankText, typeof col0 === 'string' ? col0 : null)?.holder ?? ''
    const byHolder = holder ? CARD_ISSUERS.find(i => i.pattern.test(holder)) : undefined
    if (byHolder) return { issuer: byHolder.issuer, where: byHolder.where, by: 'holder' }
    const text = `${bankText} ${typeof tx.counterparty === 'string' ? tx.counterparty : ''}`
    const byText = CARD_ISSUERS.find(i => i.pattern.test(text))
    return byText ? { issuer: byText.issuer, where: byText.where, by: 'text' } : null
  } catch {
    return null
  }
}

// A credit paid by a card issuer itself (its account's holder: a credit balance paid out
// after a returned purchase, a bonus) gives back money of a settlement: a refund, never
// revenue. The reason lib/refunds.ts refundReason gives for it, or null. An issuer only
// named in a client's text („Workshop bezahlt per Amex“) is no refund.
export function issuerCreditReason(tx: IssuerText | null | undefined): string | null {
  const issuer = cardIssuerOf(tx)
  return issuer?.by === 'holder' ? `Guthaben aus der Kreditkartenabrechnung ${issuer.issuer}` : null
}
