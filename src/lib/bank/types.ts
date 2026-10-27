export interface BankTransaction {
  /** Stable hash of the normalised fields; stored as payments.import_ref. */
  id: string
  /** ISO yyyy-mm-dd */
  date: string
  /** Positive = credit, negative = debit. */
  amount: number
  currency: string | null
  counterparty: string | null
  /** Remittance / purpose / booking text, joined. */
  text: string
  /** EndToEndId or structured creditor reference. */
  reference: string | null
  raw: string
}

/** Column indexes into the CSV header. */
export interface CsvMapping {
  date: number | null
  amount: number | null
  credit: number | null
  debit: number | null
  text: number[]
  counterparty: number | null
  currency: number | null
}

export interface ParsedStatement {
  format: 'camt' | 'csv'
  transactions: BankTransaction[]
  /** Machine-readable `code` or `code:detail`; the UI translates them. */
  warnings: string[]
  csv?: { header: string[]; rows: string[][]; mapping: CsvMapping }
}
