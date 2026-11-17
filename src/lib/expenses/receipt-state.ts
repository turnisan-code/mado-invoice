// What a statement line's receipt is (PR 9b), for the server and the page alike: pure.
import type { BankLine, BankLineReceiptSearch } from '@/types'

// A search that found nothing because Gmail failed (not one that found nothing): searched again
// by itself
export const onlyFailed = (s: BankLineReceiptSearch | null | undefined): boolean =>
  !!s && !s.chosen && !s.candidates?.length && (s.failed?.length ?? 0) > 0

// The receipt is one the owner uploaded by hand (one from Gmail, the search's or the list's, can
// be replaced from the list)
export const handReceipt = (line: Pick<BankLine, 'receipt_path' | 'receipt_search' | 'receipt_gmail'>): boolean =>
  !!line.receipt_path && !line.receipt_search?.chosen && !line.receipt_gmail

// A search as the page gets it: the receipt's text and its e-mail's stay on the server
export function receiptSearchForPage(s: BankLineReceiptSearch | null): BankLineReceiptSearch | null {
  return s ? { ...s, text: null, chosen: s.chosen ? { ...s.chosen, body_text: null } : null } : null
}
