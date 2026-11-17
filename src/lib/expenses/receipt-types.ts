// The receipt shapes a statement line stores (src/types BankLineReceiptSearch, PR 9b), from the
// engine's modules, type-only: the types module imports this, never the engine's code.
export type { GmailCandidate } from './types'
export type { ReceiptRead, ReceiptVia } from './receipt-match'
