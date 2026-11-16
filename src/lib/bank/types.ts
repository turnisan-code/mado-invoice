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
  /** More text for the invoice-number search only: easybank's Buchungstext without its line
   *  breaks, so a number broken across two lines is found. */
  search?: string
  /** What the bank charged on this line („SPESEN“ in an easybank text), shown with it. */
  fee?: number
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
  format: 'camt' | 'csv' | 'easybank'
  transactions: BankTransaction[]
  /** Machine-readable `code` or `code:detail`; the UI translates them. */
  warnings: string[]
  csv?: { header: string[]; rows: string[][]; mapping: CsvMapping }
}
