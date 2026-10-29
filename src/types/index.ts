export type Language = 'de' | 'en'
export type Currency = 'EUR' | 'USD' | 'GBP'
export type TaxTreatment = 'at_vat' | 'eu_reverse_charge' | 'non_eu'
// What a document prints as: a credit note that cancels an invoice is a Storno.
export type DocumentKind = 'invoice' | 'quote' | 'credit_note' | 'storno'
export type ClientStatus = 'active' | 'inactive' | 'lead'
export type DocumentType = 'invoice' | 'quote' | 'credit_note'
export type DocumentStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'accepted' | 'rejected' | 'cancelled'
export type VatRate = 0 | 10 | 13 | 20
export type Unit = 'hour' | 'day' | 'flat' | 'piece' | 'month' | 'session'
export type LineType = 'item' | 'heading' | 'text' | 'separator' | 'subtotal' | 'page_break'
// 'payment' is money received; 'skonto' and 'writeoff' close a balance without a transfer;
// 'credit' is an issued credit note applied to its invoice; 'refund' is money paid back on a credit note;
// 'fee' is dunning fees and interest paid on top of an invoice (money, but no turnover and no balance).
export type PaymentKind = 'payment' | 'skonto' | 'writeoff' | 'credit' | 'refund' | 'fee'
export type PaymentMethod = 'bank' | 'cash'
// Issuer details every issued document needs; one entry per Settings field group.
export type IssuerField = 'companyName' | 'address' | 'uid' | 'iban'
// Why a document cannot be issued yet (src/lib/utils/issue-checks.ts). Line problems carry the
// index in the item list and the 1-based position among item lines.
export type IssueProblem =
  | { code: 'settingsIncomplete'; fields: IssuerField[] }
  | { code: 'noClient' | 'noItems' | 'currencyNotEur' | 'reverseChargeNoUid' | 'clientCountryMissing' | 'noServiceDate' | 'negativeTotal' }
  | { code: 'periodStartMissing' | 'periodEndBeforeStart'; index?: number; position?: number }
  | { code: 'blankDescription' | 'badQuantity' | 'missingPrice' | 'badDiscount'; index: number; position: number }

export interface Settings {
  id: string
  company_name: string
  owner_name: string
  address_line1: string
  address_line2: string | null
  zip: string
  city: string
  country: string
  email: string
  phone: string | null
  website: string | null
  uid_number: string
  iban: string
  bic: string
  bank_name: string | null
  bank_account_holder: string | null
  invoice_prefix: string
  quote_prefix: string
  credit_note_prefix: string
  next_invoice_number: number
  next_quote_number: number
  next_credit_note_number: number
  next_client_number: number
  invoice_number_format: string
  quote_number_format: string
  credit_note_number_format: string
  invoice_counter_year: number | null
  quote_counter_year: number | null
  credit_note_counter_year: number | null
  invoice_number_reset_yearly: boolean
  quote_number_reset_yearly: boolean
  credit_note_number_reset_yearly: boolean
  default_payment_days: number
  default_language: Language
  default_vat_rate: VatRate
  default_unit: Unit
  default_tax_treatment: TaxTreatment
  default_quote_validity_days: number
  logo_url: string | null
  invoice_footer_de: string | null
  invoice_footer_en: string | null
  quote_footer_de: string | null
  quote_footer_en: string | null
  credit_note_footer_de: string | null
  credit_note_footer_en: string | null
  tax_note_reverse_charge_de: string | null
  tax_note_reverse_charge_en: string | null
  tax_note_non_eu_de: string | null
  tax_note_non_eu_en: string | null
  gmail_email: string | null
  gmail_access_token: string | null
  gmail_refresh_token: string | null
  gmail_token_expiry: number | null
  gmail_connected_at: string | null
  gmail_scopes: string | null
  drive_folder_id: string | null
  drive_folder_name: string | null
  bookamat_username: string | null
  bookamat_api_key: string | null
  bookamat_country: string | null
  bookamat_bank_account_id: number | null
  bookamat_cash_account_id: number | null
  bookamat_cost_account_id: number | null
  bookamat_vat_account_0: number | null
  bookamat_vat_account_rc: number | null
  bookamat_vat_account_non_eu: number | null
  bookamat_vat_account_10: number | null
  bookamat_vat_account_13: number | null
  bookamat_vat_account_20: number | null
  bookamat_accounts_year: number | null
  bookamat_auto_sync: boolean
  bookamat_last_error: string | null
  bookamat_last_error_at: string | null
  google_last_error: string | null
  google_last_error_at: string | null
  email_subject_invoice_de: string | null
  email_body_invoice_de: string | null
  email_subject_invoice_en: string | null
  email_body_invoice_en: string | null
  email_subject_quote_de: string | null
  email_body_quote_de: string | null
  email_subject_quote_en: string | null
  email_body_quote_en: string | null
  email_subject_credit_note_de: string | null
  email_body_credit_note_de: string | null
  email_subject_credit_note_en: string | null
  email_body_credit_note_en: string | null
  email_subject_reminder_de: string | null
  email_body_reminder_de: string | null
  email_subject_reminder_en: string | null
  email_body_reminder_en: string | null
  reminders_enabled: boolean
  reminder_grace_days: number
  reminder_interval_days: number
  reminder_max_level: number
  reminder_fee: number
  reminder_interest_rate: number
  default_skonto_percent: number | null
  default_skonto_days: number | null
  ui_language: Language
  // The studio's own Peppol address; empty = 9914 (Austrian VAT number) with uid_number.
  peppol_scheme?: string | null
  peppol_id?: string | null
}

export interface Client {
  id: string
  created_at: string
  client_number: string | null
  name: string
  company: string | null
  address_line1: string
  address_line2: string | null
  zip: string
  city: string
  country: string
  email: string
  phone: string | null
  uid_number: string | null
  tax_treatment: TaxTreatment
  language: Language
  currency: Currency
  // null = settings.default_payment_days
  payment_days: number | null
  // Skonto prefilled on the client's new invoices: null = the settings default, 0 = none.
  skonto_percent?: number | null
  skonto_days?: number | null
  status: ClientStatus
  tags: string[]
  notes: string | null
  reminders_opt_out: boolean
  // Further recipients (e.g. an accounting mailbox), prefilled as CC on every email to the client.
  cc_emails: string[]
  // E-invoicing: the preferred format, the client's Peppol address (empty = derived from its UID),
  // the buyer reference prefilled on its e-invoices and the supplier number it assigned to the studio.
  einvoice_format?: EInvoiceFormat | null
  peppol_scheme?: string | null
  peppol_id?: string | null
  buyer_reference?: string | null
  supplier_number?: string | null
}

// Settings values a new client starts with.
export interface ClientDefaults {
  country: string
  tax_treatment: TaxTreatment
  language: Language
  payment_days: number
  skonto_percent: number | null
  skonto_days: number | null
}

// A client's own price for a catalogue item (rate card); picking the item for that client uses it.
export interface ClientRate {
  id: string
  client_id: string
  catalogue_item_id: string
  price: number
  note: string | null
}

// What the catalogue page shows per item: document lines that use it and the latest document date.
export interface CatalogueUsage {
  uses: number
  lastUsed: string | null
}

export interface CountryOption {
  code: string
  name: string
  eu: boolean
}

// Structured e-invoice formats: ebInterface 6.1 (Austrian public sector) and Peppol BIS Billing 3.0 (UBL).
export type EInvoiceFormat = 'ebinterface' | 'ubl'

export interface CatalogueItem {
  id: string
  name_de: string
  name_en: string
  description_de: string | null
  description_en: string | null
  default_price: number
  unit: Unit
  vat_rate: VatRate
  category: string | null
  sort_order: number
  active: boolean
}

export interface Document {
  id: string
  created_at: string
  type: DocumentType
  number: string | null
  client_id: string
  client?: Client
  date: string
  service_date: string | null
  service_date_end?: string | null
  due_date: string | null
  status: DocumentStatus
  language: Language
  currency: Currency
  tax_treatment: TaxTreatment
  exchange_rate: number
  notes: string | null
  notes_internal: string | null
  converted_from_id: string | null
  recurring_schedule_id?: string | null
  cancels_document_id?: string | null
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  bookamat_booking_id?: string | null
  bookamat_error?: string | null
  bookamat_claimed_at?: string | null
  bookamat_pending?: BookamatPending[] | null
  reminder_sent_at?: string | null
  reminder_level?: number
  skonto_percent?: number | null
  skonto_days?: number | null
  sent_at?: string | null
  responded_at?: string | null
  share_token?: string | null
  share_expires_at?: string | null
  portal_viewed_at?: string | null
  drive_file_id?: string | null
  issued_at?: string | null
  pdf_path?: string | null
  // The buyer's reference (Auftragsreferenz / order number) its e-invoices carry.
  buyer_reference?: string | null
  items?: DocumentItem[]
  payments?: Payment[]
}

export interface DocumentItem {
  id: string
  document_id: string
  sort_order: number
  line_type: LineType
  description: string
  service_date: string | null
  // End of the line's service period; null = a single day (service_date).
  service_date_end?: string | null
  quantity: number | null
  unit: Unit | null
  unit_price: number | null
  vat_rate: VatRate | null
  catalogue_item_id: string | null
  discount_type?: 'percent' | 'fixed' | null
  discount_value?: number | null
}

export interface Payment {
  id: string
  document_id: string
  date: string
  amount: number
  note: string | null
  kind: PaymentKind
  method: PaymentMethod
  import_ref: string | null
  reference: string | null
  credit_note_id: string | null
}

// What the money side of a document looks like, derived from its payments (never stored).
export type PaymentState = 'nothing_due' | 'unpaid' | 'partially_paid' | 'paid' | 'written_off' | 'overpaid'

// A status as shown: the stored status, or a state derived from payments or dates.
export type DisplayStatus = DocumentStatus | 'partially_paid' | 'written_off' | 'settled' | 'expired'

// One Bookamat booking: money received on an invoice ('income') or paid back on a credit note
// ('refund', negative), per calendar year.
export type BookamatBookingKind = 'income' | 'refund'

export interface BookamatBooking {
  id: string
  document_id: string
  year: number
  booking_id: string
  amount: number
  kind: BookamatBookingKind
  booked_on: string | null
  pdf_attached_at: string | null
  created_at: string
}

// A document's Bookamat state as lists show it; 'none' when there is nothing to book (yet).
export type BookamatState = 'synced' | 'unsynced' | 'failed' | 'none'

// documents.bookamat_pending: a booking a sync was about to post (no booking_id: the outcome is
// unknown until Bookamat is asked) or posted but could not record. The next sync settles it first.
export interface BookamatPending {
  year: number
  kind: BookamatBookingKind
  booking_id: string | null
  amount: number
  date: string
  title: string
  at: string
}

export interface ReminderLogEntry {
  id: string
  document_id: string
  level: number
  sent_at: string
  to_email: string | null
  subject: string | null
}

export type DocumentEventType =
  | 'issued' | 'emailed' | 'mailto_opened' | 'reminder_sent' | 'status_changed'
  | 'payment_added' | 'payment_removed' | 'storno_created' | 'archived' | 'drive_archived'
  | 'portal_viewed' | 'portal_responded' | 'bookamat_synced' | 'converted' | 'einvoice_exported'

export interface DocumentEvent {
  id: string
  document_id: string
  created_at: string
  type: DocumentEventType
  detail: Record<string, unknown>
}

export type EmailTemplateKind = 'invoice' | 'quote' | 'credit_note' | 'reminder'

// What the reminder dialog shows before anything is sent or recorded.
export interface ReminderDraft {
  level: number
  title: string
  number: string
  to: string
  cc: string[]
  subject: string
  body: string
  attachments: string[]
  gmail: boolean
}

// One printed row between an invoice's total and its balance due: money received, an applied
// credit note, Skonto or a write-off (src/lib/payment-summary.ts).
export interface PaymentSummaryLine {
  kind: 'paid' | 'credit' | 'skonto' | 'writeoff'
  amount: number
  creditNoteNumber: string | null
}

export interface DocumentTotals {
  subtotal: number
  discount_amount: number
  vat_groups: { rate: VatRate; base: number; amount: number }[]
  total_vat: number
  total: number
  total_paid: number
  balance_due: number
}

export type RecurringInterval = 'weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'yearly'
export type RecurringMode = 'draft' | 'issue'

export interface RecurringSchedule {
  id: string
  created_at: string
  source_document_id: string
  name: string
  interval: RecurringInterval
  anchor_day: number
  next_date: string
  end_date: string | null
  active: boolean
  in_advance: boolean
  mode: RecurringMode
  last_generated_at: string | null
  last_document_id: string | null
}
