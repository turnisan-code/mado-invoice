// The part of Bookmatic lib/receipt-match.ts (475072f) the Buchungsregeln need before any
// Gmail search exists in Mado (9a): which notes belong to a Gmail receipt, and when an
// attached receipt is doubtful. PR 9b („Belege aus Gmail“) ports the rest of the module
// (the proof rules, the candidates) around these two, unchanged.
import type { MatchedTransaction } from '@/lib/expenses/types'
import { RECEIPT_UNREADABLE_NOTE } from './invoice-parsing'

/**
 * The notes Analyse writes about a Gmail receipt it attached — where it came from, how its
 * amount or number proved it, or why it is doubtful —, and those written before P2-11: they
 * go with the receipt when a pick of another rule drops it (lib/rule-match.ts pickRule)
 */
export function isGmailReceiptNote(part: string): boolean {
  return part.startsWith('Gmail: ') || part.startsWith('Gmail-Suche nach ') || / im E-Mail-Text$/.test(part)
    || /^(?:Betrag|Zahlbetrag) .+ stimmt(?: \(Kartenumsatz\))?$/.test(part)
    || part.startsWith('Rechnungsnr. ') || part === RECEIPT_UNREADABLE_NOTE
    || part.startsWith('⚠ Beleg über Rechnungsnr. ') || /^⚠ \d+ Belege mit Betrag /.test(part) || part.startsWith('⚠ Beleg von ')
    || part.startsWith('⚠ In derselben E-Mail „')
}

// A Gmail receipt attached without proof (P2-11): its number only, the nearest of several,
// D2's unchecked one — or attached by an Analyse before the update. Never ticked for the
// owner; „Alle“ and „Trotzdem buchen“ leave it to him.
export const receiptDoubt = (t: Pick<MatchedTransaction, 'gmail_message_id' | 'receipt_check'> | null | undefined): boolean =>
  !!t?.gmail_message_id && t.receipt_check !== 'amount' && t.receipt_check !== 'owner'
