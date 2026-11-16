// ── bookamat account types (shared across receipt, import, vendors pages) ──────

export interface BookamatAccount {
  id: number
  name: string
  purchasetaxaccounts?: BookamatAccount[]
  // Umsatzsteuer/Vorsteuer accounts: "1" = sales side (Umsatzsteuer Inland, IG/Drittland
  // Lieferungen/Leistungen, Keine Umsatzsteuer, Umsätze §19 …), "2" = purchase side
  // (Vorsteuer Inland, IG/Drittland Erwerb, Einfuhr-USt, Keine Vorsteuer …)
  group?: string | number | null
  // Steuer- and Ertragskonten: a value bookamat locks for this account (BA USt %, BA
  // Betrag %); null = free. Read with lib/account-locks.ts, never with Number() (null ≠ 0).
  deductibility_tax_percent?: string | number | null
  deductibility_amount_percent?: string | number | null
  // Steuerkonten: true = one of bookamat's „Anlagen“ (an asset account: BA Betrag locked 0,
  // written off in bookamat). Read with lib/account-locks.ts isAssetAccount.
  inventory?: boolean | null
  // Steuerkonten: bookamat's section of the chart („Anlagen“ …), information only
  section?: string | null
  // Umsatzsteuer/Vorsteuer accounts: the USt rates bookamat takes on this account
  // („20.00“, „4.90“; [""] = any). Read with lib/vat-origin.ts allowedRates.
  tax_values?: (string | number)[] | null
}

export interface BookamatAccounts {
  cost_accounts: BookamatAccount[]
  purchasetax_accounts: BookamatAccount[]
  bank_accounts: BookamatAccount[]
  revenue_accounts?: BookamatAccount[]
  // The year whose books bookings go into (/api/bookamat-accounts sends it)
  year?: number
  // Where that year is set: Einstellungen, or the BOOKAMAT_YEAR variable
  year_source?: 'stored' | 'env'
  // When the lists were read from bookamat (information only)
  read_at?: string
}

// ─────────────────────────────────────────────────────────────────────────────

export interface Vendor {
  id: string
  name: string
  match_strings: string[]       // strings to match in bank CSV counterparty
  email_sender: string          // e.g. "billing@adobe.com" or "@adobe.com"
  cost_account_id: number       // bookamat costaccount ID
  purchasetax_account_id: number // bookamat purchasetaxaccount ID
  bank_account_id: number       // bookamat bankaccount ID
  tax_percent: number           // e.g. 20, 13, 10, 4.9, 0
  deductibility_tax_percent: number    // e.g. 100
  deductibility_amount_percent: number // e.g. 80 for 80% business use
  country: string               // e.g. "US", "IE", ""
  vatin: string                 // vendor VAT ID if applicable
  title_template: string        // e.g. "Adobe Creative Cloud – {month}"
  category: string              // display label
  active: boolean
  // Amount-based disambiguation (e.g. two Adobe subscriptions at different prices)
  amount_min: number | null     // only match if transaction amount >= this
  amount_max: number | null     // only match if transaction amount <= this
  // Address-based disambiguation (e.g. Magenta studio vs home office)
  invoice_address_match: string // if set, only match if PDF contains this string
  // Email-body disambiguation (e.g. Google Payments Profile ID to pick the right invoice)
  email_body_keywords: string[] // if set, only use emails whose body contains ALL of these strings
  notes_template: string       // maps to bookamat description field
  skip_invoice_search: boolean  // if true, skip Gmail search for this vendor
}

export interface EasybankTransaction {
  date: string           // debit date from bank
  counterparty: string   // who was paid / who paid us
  amount: number         // absolute gross amount debited (always positive)
  type: 'expense' | 'income'
  currency: string
  reference: string
  raw: Record<string, string>
  fee?: number           // bank fee bundled into the debit ("SPESEN: X,XX"); invoice = amount − fee
  net_amount?: number    // goods amount before the fee (amount − fee), for receipt matching
}

export interface AiIncomeSuggestion {
  revenue_account_id: number
  vat_account_id: number
  bank_account_id: number
  vat_percent: number
  country: string         // customer country (empty = AT)
  vatin: string           // customer VAT ID
  title: string
  category: string
  reasoning: string
  certainty?: 'hoch' | 'niedrig'  // 'niedrig' = evidence was thin/ambiguous — never auto-approve, show a visible marker
  // 'rule': set by a fixed rule (Privateinlage), not by the AI — the row may be pre-ticked
  source?: 'ai' | 'rule'
  // Set on every AI suggestion the income account guard (PR „Vorsteuer“) checked, changed
  // or not. A suggestion without it was made before that update (a draft, or a tab open
  // since then): checked when the draft is loaded, refused by the booking route while its
  // Ertragskonto is not the owner's pick.
  revenue_checked?: boolean
}

export interface AiSuggestion {
  cost_account_id: number
  purchasetax_account_id: number
  bank_account_id: number
  tax_percent: number
  deductibility_amount_percent: number
  deductible_share?: number              // 0.0–1.0 mirror of deductibility_amount_percent (spec: proportion, not a bool)
  country: string
  supplier_region?: 'AT' | 'EU' | 'third_country' // drives IG-Erwerb vs. Drittland-Erwerb account mapping; independent of the 057 self-assessment
  vatin: string
  title: string
  category: string
  reasoning: string
  requires_invoice: boolean   // false for private/SVS/Finanzamt/Miete; true for vendor expenses
  certainty?: 'hoch' | 'niedrig'  // 'niedrig' = evidence was thin/ambiguous — never auto-approve, show a visible marker
  // 'rule': set by a fixed rule (a transfer to the owner's own account, lib/own-transfer.ts),
  // not by the AI; 'ai': the classifier's. A row analysed before PR 4a has none.
  source?: 'ai' | 'rule'
  // Set on every suggestion the classifier's Vorsteuer guards (PR „Vorsteuer“) checked,
  // changed or not. A suggestion without it was made before that update (a draft, or a tab
  // open since then): guarded when the draft is loaded, refused by the booking route
  // unless the owner set its accounts and VAT himself.
  vorsteuer_checked?: boolean
}

export interface MatchedTransaction {
  transaction: EasybankTransaction
  vendor: Vendor | null
  confidence: number            // 0-1
  gmail_message_id: string | null
  // The Gmail receipt's part of that message (MessagePart.partId; P2-11): the booking and the
  // preview fetch that PDF again by it. A row analysed before has none: it is fetched by the
  // selector Analyse used then (lib/gmail-parts.ts pdfPartFor), so it is the PDF attached.
  gmail_part_id?: string | null
  gmail_subject: string | null
  gmail_date: string | null
  pdf_attachment_name: string | null
  pdf_base64: string | null
  extracted_invoice_date: string | null
  extracted_invoice_number: string | null
  extracted_amount: number | null
  title: string                 // suggested booking title
  status: 'ready' | 'needs_review' | 'no_invoice' | 'missing_invoice' | 'unknown_vendor' | 'duplicate'
  match_note?: string | null    // one-line rationale for the auto-matched receipt (trust/debuggability)
  ai_suggested?: AiSuggestion   // populated when vendor is unknown, Claude classified it
  ai_error?: string             // set when classification failed (API/parse error) — vs. intentional skip
  booking_lines?: BookingLine[] // multi-line split (restaurant VAT rates, or goods + bank fee)
  override?: Record<string, string> // flat field-name → value overrides from the UI (cost_account_id, tax_percent, …), not a BookingPayload fragment
  // The existing bookamat booking this payment most likely repeats (lib/duplicates.ts):
  // certain → status 'duplicate' („Bereits gebucht“); otherwise „möglicherweise
  // bereits gebucht“. Either is held until the owner books it anyway.
  duplicate_of?: DuplicateInfo | null
  // The row's own status before a certain match made it 'duplicate'. Once the owner
  // books it anyway, this status (e.g. 'missing_invoice') applies again.
  own_status?: MatchedTransaction['status']
  // Set when the duplicate check could not run during Analyse; the booking route
  // checks again and does not book while it cannot check.
  duplicate_check_failed?: string
  // Bookings the owner said are NOT this payment („trotzdem buchen“). The booking
  // route still checks against every other booking.
  ack_duplicate_ids?: number[]
  // The Buchungsregeln that fit this payment (lib/rule-match.ts, P2-7), as Analyse read
  // them, in rule order: with vendor null, the rules that fit equally — the owner picks
  // one („Regel wählen“); with a vendor, the rules it was chosen among (an amount range,
  // the invoice address on the receipt), so another can be applied instead
  rule_choices?: Vendor[]
  // How the rule among rule_choices was chosen: by the owner, or by the invoice address
  // on the receipt attached
  rule_pick?: 'owner' | 'address'
  // Set on every expense row Analyse matched against the Buchungsregeln since PR „Job 1
  // fixes“. A Buchungsregel's row without it was analysed before: its rule may have won a
  // tie by list order, so the booking route checks it again (lib/rule-match.ts
  // ruleChoiceReason) and a draft's load converts it (ruleTieDraftRows)
  rule_tie_checked?: boolean
  // The Buchungsregeln whose sender's Gmail search found the receipt attached (ids): a
  // pick of another rule drops that receipt (lib/rule-match.ts pickRule)
  gmail_rule_ids?: string[]
  // How the Gmail receipt attached was proven (P2-11, lib/receipt-match.ts): its amount
  // equals the debit ('amount'), only the bank text's invoice number is on it ('number'), it
  // is the nearest of several of the debit's amount ('ambiguous'), a Buchungsregel's
  // sender's only PDF whose amount could not be checked ('unchecked'), or the owner attached
  // it from the list ('owner'). Only 'amount' and 'owner' are ticked or taken by „Alle“. A
  // row analysed before P2-11 has none.
  receipt_check?: ReceiptCheck
  // The PDFs and e-mails Analyse found but did not attach (set when nothing, or a doubtful
  // receipt, is attached); never with their data
  gmail_candidates?: GmailCandidate[]
}

export type ReceiptCheck = 'amount' | 'number' | 'ambiguous' | 'unchecked' | 'owner'

// A Gmail PDF (or an e-mail without one) Analyse found for a debit and did not attach, with
// why (lib/receipt-match.ts gmailCandidateLabel says it): of another amount, in another
// currency, unreadable or not checked, attached to another row, a credit note, no invoice,
// another invoice number, an e-mail without PDF, over 10 MB, more than 10 pages
export interface GmailCandidate {
  message_id: string
  part_id: string | null        // null: an e-mail without PDF
  file_name: string | null
  subject: string
  from: string
  date: string | null           // the e-mail's Date header
  size: number | null
  amount: number | null         // the euro total read
  currency: string | null       // only when not EUR
  foreign_total: number | null
  invoice_number: string | null
  document_type?: string | null
  why: 'amount' | 'foreign' | 'unreadable' | 'unchecked' | 'claimed' | 'credit_note' | 'not_invoice' | 'number' | 'no_pdf' | 'too_large' | 'pages'
  claimed_by?: string | null    // the row it is attached to (lib/receipt-match.ts rowLabel)
  // Found by a Buchungsregel's „E-Mail Absender“ search: the sender searched and the rules
  // whose search found it. „Anhängen“ gives the row its gmail_rule_ids from them
  // (lib/gmail-attach.ts), so a pick of another rule drops it as it drops a receipt Analyse
  // attached (lib/rule-match.ts pickRule). None on the name and payment processor searches.
  found_by?: { sender: string; rule_ids: string[] }
}

export interface DuplicateInfo {
  id: number
  title: string
  date: string
  total: number
  certain: boolean
  // The Zahlungsmittelkonto the booking is on, when every line names the same one
  bank?: string
  // Only when true: a restaurant receipt's card debit with a tip on top, found by the
  // receipt book route's forward check („mit Trinkgeld?“, P2-3); never certain
  viaTip?: true
}

// One booking line within a multi-line expense (e.g. Speisen 10% / Getränke 20%
// / Trinkgeld 0% for a restaurant bill, or goods + separate bank-fee line).
export interface BookingLine {
  label: string                        // "Speisen (10%)", "Bankspesen", …
  amount_gross: number                 // gross amount for this line
  vat_percent: number                  // 20 | 10 | 0
  deductibility_amount_percent?: number // BA Betrag %: 50 for Bewirtung, else 100
  deductibility_tax_percent?: number    // BA USt %: deductible share of the input VAT
  // Per-line accounts. A split can mix Steuerkonten (e.g. Lizenzgebühren + a bank-fee
  // account), so each line may carry its own. When unset, the booking falls back to
  // the row's shared cost/purchasetax/bank account (backwards-compatible).
  cost_account_id?: number             // per-line Aufwandskonto (Steuerkonto)
  purchasetax_account_id?: number      // per-line Vorsteuerkonto
  bank_account_id?: number             // per-line Zahlungsmittelkonto
}

export interface MatchedIncomeTransaction {
  transaction: EasybankTransaction  // type === 'income'
  drive_file_id: string | null      // Google Drive file ID of matched invoice
  drive_file_name: string | null
  pdf_base64: string | null
  extracted_invoice_number: string | null
  extracted_invoice_date: string | null
  extracted_amount: number | null
  title: string
  status: 'ready' | 'needs_review' | 'no_invoice' | 'unknown' | 'duplicate'
  match_note?: string | null        // one-line rationale for the auto-matched invoice
  drive_error?: string              // Drive search error message (OAuth failure, folder not accessible, etc.)
  ai_error?: string                 // set when classification failed (API/parse error) — vs. intentional skip
  ai_suggested?: AiIncomeSuggestion
  override?: Record<string, string>
  duplicate_of?: DuplicateInfo | null
  own_status?: MatchedIncomeTransaction['status']
  duplicate_check_failed?: string
  ack_duplicate_ids?: number[]
  // The Mado invoice this credit pays (RN-202605008 or later): Mado books it, so the
  // row cannot be booked here (lib/invoice-parsing.ts madoInvoiceKey)
  mado_invoice?: string | null
  // A refund from an expense vendor (a Buchungsregel's, SVS, Finanzamt, a payment
  // processor): not revenue, never booked here — the reason shown on the row
  refund?: string | null
  // How the Drive invoice came (P1-10): 'number' — attached by the bank text's invoice
  // number, confirmed in the PDF; 'none' — none attached. Missing on rows built before
  // P1-10, whose Drive file was picked by its amount (lib/drive-invoices.ts)
  drive_match?: 'number' | 'none'
  // The row's Beleg note: which Drive invoice it has, or why none
  invoice_note?: string | null
}

export interface BookingPayload {
  title: string
  date: string                  // bank debit date
  date_invoice: string | null
  date_delivery?: string | null // Lieferdatum — required by bookamat for some purchasetax accounts (IG-Erwerb etc.)
  amounts: {
    bankaccount: number
    costaccount: number
    purchasetaxaccount?: number  // optional: omit for 0% VAT lines
    amount: string
    tax_percent: string
    // deductibility fields are optional: bookamat "blocks" them for some cost
    // accounts (it computes them itself) and rejects the booking if they're sent.
    deductibility_tax_percent?: string
    deductibility_amount_percent?: string
    country_dep: string
    country_rec: string
  }[]
  vatin: string
  country: string
  description: string
}

export interface ProcessedBooking {
  id: string
  created_at: string
  transaction_date: string
  vendor_name: string
  amount: number
  bookamat_booking_id: number
  gmail_message_id: string | null
  source: 'csv' | 'email_forward' | 'receipt'
  status: 'booked' | 'skipped'
}

export interface InboxEmail {
  id: string
  received_at: string
  from_name: string
  from_email: string
  subject: string
  extracted_vendor: string | null
  extracted_amount: number | null
  extracted_date: string | null
  extracted_invoice_number: string | null
  pdf_attachment_name: string | null
  suggested_vendor_id: string | null
  status: 'pending' | 'booked' | 'skipped'
  raw_gmail_id: string
}

export interface ReceiptUpload {
  id: string
  uploaded_at: string
  image_url: string
  extracted_vendor: string | null
  extracted_amount: number | null
  extracted_date: string | null
  extracted_invoice_number: string | null
  suggested_vendor_id: string | null
  ai_confidence: number
  status: 'pending' | 'booked' | 'skipped'
}
