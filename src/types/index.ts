export type Language = 'de' | 'en'
export type Currency = 'EUR' | 'USD' | 'GBP'
export type TaxTreatment = 'at_vat' | 'eu_reverse_charge' | 'non_eu'
export type ClientStatus = 'active' | 'inactive' | 'lead'
export type DocumentType = 'invoice' | 'quote' | 'credit_note'
export type DocumentStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'accepted' | 'rejected' | 'cancelled'
export type VatRate = 0 | 10 | 13 | 20
export type Unit = 'hour' | 'day' | 'flat' | 'piece' | 'month' | 'session'
export type LineType = 'item' | 'heading' | 'text' | 'separator' | 'subtotal' | 'page_break'

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
  invoice_prefix: string
  quote_prefix: string
  credit_note_prefix: string
  next_invoice_number: number
  next_quote_number: number
  next_credit_note_number: number
  invoice_number_format: string
  quote_number_format: string
  credit_note_number_format: string
  default_payment_days: number
  default_language: Language
  logo_url: string | null
  invoice_footer_de: string | null
  invoice_footer_en: string | null
  quote_footer_de: string | null
  quote_footer_en: string | null
  gmail_email: string | null
  gmail_access_token: string | null
  gmail_refresh_token: string | null
  gmail_token_expiry: number | null
  drive_folder_id: string | null
  drive_folder_name: string | null
  bookamat_username: string | null
  bookamat_api_key: string | null
  bookamat_country: string | null
  bookamat_bank_account_id: number | null
  bookamat_cost_account_id: number | null
  bookamat_vat_account_0: number | null
  bookamat_vat_account_10: number | null
  bookamat_vat_account_13: number | null
  bookamat_vat_account_20: number | null
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
}

export interface Client {
  id: string
  created_at: string
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
  payment_days: number
  status: ClientStatus
  tags: string[]
  notes: string | null
}

export interface CatalogueItem {
  id: string
  name_de: string
  name_en: string
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
  due_date: string | null
  status: DocumentStatus
  language: Language
  currency: Currency
  tax_treatment: TaxTreatment
  exchange_rate: number
  notes: string | null
  notes_internal: string | null
  converted_from_id: string | null
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  bookamat_booking_id?: string | null
  reminder_sent_at?: string | null
  share_token?: string | null
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
  quantity: number | null
  unit: Unit | null
  unit_price: number | null
  vat_rate: VatRate | null
  catalogue_item_id: string | null
}

export interface Payment {
  id: string
  document_id: string
  date: string
  amount: number
  note: string | null
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
