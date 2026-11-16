/**
 * Transfers between the owner's own accounts (audit P1-12).
 *
 * The expense prompt used to call every payment with an IBAN or BIC in its text a private
 * transfer. Column 0 of the easybank CSV (the account's own IBAN) is in every prompt, so
 * it fired on every row: in production it titled nine business payments „Privatentnahme“
 * (two supplier invoices, ESt, USt, 4× Amazon, PayLife), two without any warning. An own
 * transfer is recognised here instead, in code, before any Buchungsregel, receipt search
 * or AI: the holder of the counterparty account is the owner himself.
 *
 * Pure, no server imports: lib/refunds.ts imports this, and it is in the client bundle.
 */

import type { AiSuggestion, BookamatAccounts } from '@/lib/expenses/types'

// Mado: OWNER_NAME and OWN_BUSINESS_IBANS come from Einstellungen (the owner's name, the
// IBAN on his invoices and his other business accounts), set by lib/expenses/owner.ts
// setExpenseOwner before the engine runs — on the server per request and on the page from
// the settings it was given, so both read the same. Bookmatic kept them as constants here.

// The owner's name as the bank prints it as an account holder („Konrad Testmann“,
// „TESTMANN KONRAD“); '' = none set: then no holder is the owner.
export let OWNER_NAME = ''

/** An IBAN as it is compared: no spaces, upper-case. */
export const normIban = (v: string | null | undefined): string => (v || '').replace(/\s+/g, '').toUpperCase()

// The owner's other BUSINESS accounts (another bank's). A transfer to or from one of them is
// no Privatentnahme/Privateinlage, even with the owner as its holder. Never list a card
// issuer's or a collector's IBAN here (PayLife AT37…): its debits are business expenses.
export let OWN_BUSINESS_IBANS: string[] = []

// The IBAN lengths of the countries that occur; any other country 15–34 characters
const IBAN_LENGTH: Record<string, number> = {
  AT: 20, DE: 22, IE: 22, LT: 20, CH: 21, LU: 20, NL: 18, BE: 16, GB: 22, FR: 27, IT: 27,
  ES: 24, PL: 28, CZ: 24, SK: 24, HU: 28, SI: 19, HR: 21, SE: 24, DK: 18, FI: 18, PT: 25,
}
// Greedy and word-bounded: a whole token, never a prefix of a longer one. No mod-97 check.
const IBAN_TOKEN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g

/** Is this an IBAN (shape and, for a known country, length)? */
export function isIban(v: string | null | undefined): boolean {
  const iban = normIban(v)
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  const length = IBAN_LENGTH[iban.slice(0, 2)]
  return !length || iban.length === length
}

export type CounterpartyAccount = { iban: string; holder: string }

/**
 * The counterparty's account in an easybank bank text: the first IBAN that is not the
 * CSV's own (column 0), and its holder. The „|“ in the text is a line break at 57
 * characters, not a field separator: the holder is the text after the IBAN on the same
 * line („…|BIC IBAN Konrad Testmann|Private Auszahlung“, „…|IBAN Wien 3/6/7/11/15
 * Schwechat Gerasd|2607/09+88300E“). Only when nothing follows it there and the next line
 * is the last one, that line is the holder („…|BIC IBAN|Beispiel GmbH“). Otherwise there
 * is none (''). A card row has no IBAN; „SOFTWARE“ or „BROTHERS“ are no account.
 */
export function findCounterpartyAccount(bankText: string | null | undefined, ownIban?: string | null): CounterpartyAccount | null {
  const lines = (bankText || '').split('|')
  const own = normIban(ownIban)
  for (let k = 0; k < lines.length; k++) {
    const re = new RegExp(IBAN_TOKEN.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(lines[k]))) {
      const iban = m[0]
      if (!isIban(iban) || iban === own) continue
      let holder = lines[k].slice(m.index + iban.length).trim()
      if (!holder && k === lines.length - 2) holder = lines[k + 1].trim()
      return { iban, holder }
    }
  }
  return null
}

// A name's words, as compared: lower-case, without diacritics, anything but a letter a
// space („Testmann, Konrad“ → testmann konrad)
const nameText = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z]+/g, ' ')
const nameTokens = (s: string): string[] => nameText(s).trim().split(' ').filter(Boolean)
let OWNER_TOKENS: string[] = []

// The owner as Einstellungen name him: his name and his business accounts (lib/expenses/owner.ts)
export function setOwner(owner: { name?: string | null; businessIbans?: readonly (string | null | undefined)[] | null }): void {
  OWNER_NAME = (owner.name ?? '').trim()
  OWNER_TOKENS = nameTokens(OWNER_NAME)
  OWN_BUSINESS_IBANS = Array.from(new Set((owner.businessIbans ?? []).map(normIban).filter(isIban)))
}

/**
 * Is this account holder the owner himself, in either order („Konrad Testmann“,
 * „TESTMANN KONRAD“, „Testmann, Konrad“)? Exactly his name: anything more (e.U., GmbH, a
 * title, a second person, a firm name) is another account holder.
 */
export function isOwnerName(holder: string | null | undefined): boolean {
  const words = nameTokens(holder || '').sort()
  const owner = OWNER_TOKENS.slice().sort()
  return owner.length > 0 && words.length === owner.length && words.every((w, k) => w === owner[k])
}

// What may stand beside the owner's name on an account that is still his: an academic or
// honorific title (Mag., Dr., DI, Dipl.-Ing., Ing., MA, BA, MSc, BSc, Prof.) or „e.U.“ /
// „eU“ (his sole proprietorship is no other person). As name words: „Dipl.-Ing.“ is
// „dipl ing“, „e.U.“ is „e u“ (read as one).
const NAME_EXTRAS = new Set(['mag', 'dr', 'di', 'dipl', 'ing', 'ma', 'ba', 'msc', 'bsc', 'prof', 'eu'])

/**
 * Is this account holder the owner, alone or with only a title or „e.U.“ besides („Mag.
 * Konrad Testmann“, „Konrad Testmann e.U.“, „TESTMANN KONRAD, MSc“)? Not the fixed rule's
 * test (isOwnerName, his name exactly), but the question whether an account the rule did
 * not take is still one of his own. A firm (GmbH, OG, KG, AG) is a separate legal person,
 * and any other word a second person or a firm name: no.
 */
export function ownerNameWithExtras(holder: string | null | undefined): boolean {
  if (OWNER_TOKENS.length === 0) return false
  const rest = nameText(holder || '').replace(/(^| )e u(?= |$)/g, '$1eu').trim().split(' ').filter(Boolean)
  for (const w of OWNER_TOKENS) {
    const k = rest.indexOf(w)
    if (k < 0) return false
    rest.splice(k, 1)
  }
  return rest.every(w => NAME_EXTRAS.has(w))
}

/**
 * Does the owner's full name (either order, with or without a comma) stand in the bank
 * text outside the holder field („…Vers.-Nr. …, Testmann Konrad|…|BIC IBAN|Muster Versicherung
 * …“)? The lines are joined without a separator first: the bank cuts names and words at
 * the line break. The surname alone never counts („GOOGLE WORKSPACE_TESTM“). `holder`:
 * the holder field, when the caller has it; else it is read from the text.
 */
export function ownerNameInText(bankText: string | null | undefined, holder?: string | null): boolean {
  try {
    if (OWNER_TOKENS.length === 0) return false
    const text = bankText || ''
    const field = (holder ?? findCounterpartyAccount(text)?.holder ?? '').trim()
    const at = field ? text.indexOf(field) : -1
    const outside = at >= 0 ? text.slice(0, at) + text.slice(at + field.length) : text
    const joined = nameText(outside.split('|').join(''))
    const reversed = [OWNER_TOKENS[OWNER_TOKENS.length - 1], ...OWNER_TOKENS.slice(0, -1)]
    return [OWNER_TOKENS, reversed].some(words => joined.includes(words.join(' ')) || joined.includes(words.join('')))
  } catch {
    return false
  }
}

/**
 * A private title or category: „Privatentnahme“, „Privateinlage“ (also „Privat-Entnahme“).
 * Shared by the classifier's guards, the drafts and the import page.
 */
export const PRIVATE_TITLE = /privat\s*-?\s*(entnahme|einlage)/i

/**
 * A guess that called a debit private — no Beleg needed (requires_invoice false, a
 * private title or category, no Buchungsregel) — booked on a business Steuerkonto after
 * all: a business expense needs its Beleg like any other, so the import page blocks it
 * like a missing one. `bookedCostAccounts`: the Steuerkonto names the booking's lines use
 * (undefined: not known); `hasReceipt`: a receipt attached by hand or found at Analyse.
 */
export function privateGuessOnBusiness(
  t: { vendor?: unknown; ai_suggested?: Pick<AiSuggestion, 'requires_invoice' | 'title' | 'category'> | null },
  bookedCostAccounts: (string | null | undefined)[],
  hasReceipt: boolean,
): boolean {
  const ai = t.ai_suggested
  if (t.vendor || !ai || ai.requires_invoice !== false) return false
  if (!PRIVATE_TITLE.test(`${ai.title || ''} ${ai.category || ''}`)) return false
  // Only an account that needs a Beleg counts: a private one does not, nor a tax payment
  // (Einkommensteuer, Umsatzsteuer laufendes Jahr) or the Sozialversicherung — where the
  // old IBAN rule's ESt/USt „Privatentnahme“ rows belong
  return !hasReceipt && bookedCostAccounts.some(name => !!name && !NO_BELEG_ACCOUNT.test(name))
}
const NO_BELEG_ACCOUNT = /privat|einkommensteuer|umsatzsteuer|sozialversicherung/i

// An invoice-like token: RN-/RN:/RN_ + digits, „Re-“ + digits, „Rg“ + digits, „Rechnung“
// (Rechnungsnr., Rechnungsnummer, Rechnung Nr.) + number, INV-…. It must start a word.
// (invoice-parsing's helpers are narrower — RN with six digits — or looser: „RG“ inside
// „Salzburg 1234“.)
const INVOICE_REF = /(?:^|[^A-Za-z0-9ÄÖÜäöüß])(RN\s*[-:_\/]?\s*\d+(?:[-\/]\d+)*|Re\s*-\s*\d+(?:[-\/]\d+)*|Rg\.?\s*(?:-?\s*Nr\.?)?\s*[-:#]?\s*\d+|Rechnung(?:s?\s*-?\s*(?:nummer|nr\.?|no\.?))?\s*[-:#]?\s*\d+|INV\s*-\s*[A-Z0-9]+(?:-[A-Z0-9]+)*)/i

// The first invoice-like token of a bank text outside its holder field. The lines are
// read joined both ways: a number cut at the line break, and a token at a line's start.
function invoiceRefOutside(bankText: string, holder: string): string | null {
  const at = holder ? bankText.indexOf(holder) : -1
  const outside = at >= 0 ? bankText.slice(0, at) + bankText.slice(at + holder.length) : bankText
  const lines = outside.split('|')
  const m = lines.join(' ').match(INVOICE_REF) || lines.join('').match(INVOICE_REF)
  return m ? m[1].trim() : null
}

export type OwnTransfer = {
  iban: string
  holder: string
  // An invoice-like token in the bank text („RE-12345“): an Auslagenersatz, or a client
  // paying through the owner's private account — never decided by the fixed rule alone
  invoiceRef: string | null
}

// An own transfer whose text names an invoice, where no suggestion asks about it
// (bookamat's lists missing, lib/matcher.ts; the import page's box): its note, with the
// question appended
export const withInvoiceQuestion = (text: string, own: Pick<OwnTransfer, 'invoiceRef'>): string =>
  own.invoiceRef
    ? `${text} · ⚠ Rechnungsnummer „${own.invoiceRef}“ im Text — Auslagenersatz? Dann die Ausgabe selbst gesondert buchen.`
    : text

type TransferText = { reference?: string | null; raw?: Record<string, string> | null }

/**
 * A bank row's counterparty account (findCounterpartyAccount), read from its bank text:
 * column 1, else the reference; never the CSV's own IBAN (column 0). For a credit, the
 * paying account and its holder. Never throws: odd text (a draft's row) has none.
 */
export function counterpartyAccountOf(tx: TransferText | null | undefined): CounterpartyAccount | null {
  try {
    if (!tx) return null
    const col1 = tx.raw?.col1
    const col0 = tx.raw?.col0
    return findCounterpartyAccount(typeof col1 === 'string' ? col1 : (tx.reference || ''), typeof col0 === 'string' ? col0 : null)
  } catch {
    return null
  }
}

/**
 * A transfer between this account and one of the owner's own private accounts: the
 * counterparty account's holder is exactly the owner, and it is none of his business
 * accounts (checked first). Read from the bank text (column 1, else the reference), never
 * from transaction.counterparty: the parser stops at the purpose text („Private
 * Auszahlung“). The owner's name in the reference alone („Büromiete Musterstraße 1Konrad
 * Testmann“) is no transfer. Never throws: odd text is no transfer.
 */
export function ownTransfer(tx: TransferText | null | undefined): OwnTransfer | null {
  try {
    if (!tx) return null
    const col1 = tx.raw?.col1
    const bankText = typeof col1 === 'string' ? col1 : (tx.reference || '')
    const col0 = tx.raw?.col0
    const account = findCounterpartyAccount(bankText, typeof col0 === 'string' ? col0 : null)
    if (!account) return null
    if (OWN_BUSINESS_IBANS.includes(account.iban)) return null
    if (!isOwnerName(account.holder)) return null
    return { iban: account.iban, holder: account.holder, invoiceRef: invoiceRefOutside(bankText, account.holder) }
  } catch {
    return null
  }
}

/**
 * The „ALLE CSV-FELDER“ lines of the expense prompt („  key: value“), without the CSV's
 * own IBAN (column 0, and any field holding the same IBAN): it is on every row and says
 * nothing about the payment. `raw` itself is unchanged; the import page shows it.
 */
export function promptCsvFields(raw: Record<string, string> | null | undefined): string {
  const fields = raw || {}
  const own = isIban(fields.col0) ? normIban(fields.col0) : ''
  return Object.entries(fields)
    .filter(([, v]) => v)
    .filter(([, v]) => !own || normIban(String(v)) !== own)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n')
}

/**
 * The fixed rule's suggestion for an own transfer (a debit): „Privatentnahmen
 * (allgemein)“ (that exact name, else the only Steuerkonto starting with
 * „Privatentnahme“), „Keine Vorsteuer“ (linked to it, else by name in the list), 0 %, on
 * the CSV's own bank account. Certain — unless the text names an invoice (Auslagenersatz?
 * then the expense itself is booked on its own). Null when bookamat lacks either account.
 */
export function ownTransferExpenseSuggestion(
  own: OwnTransfer,
  lists: Pick<BookamatAccounts, 'cost_accounts' | 'purchasetax_accounts'> | null | undefined,
  csvBankId: number,
): AiSuggestion | null {
  const costAccounts = lists?.cost_accounts ?? []
  const squash = (name: string) => name.replace(/\s+/g, '').toLowerCase()
  const named = costAccounts.filter(a => /^privatentnahme/i.test(a.name.trim()))
  const cost = costAccounts.find(a => squash(a.name) === 'privatentnahmen(allgemein)') ?? (named.length === 1 ? named[0] : undefined)
  if (!cost) return null
  const keineVorsteuer = (a: { name: string }) => /^keine\s*vorsteuer/i.test(a.name.trim())
  const tax = (cost.purchasetaxaccounts ?? []).find(keineVorsteuer) ?? (lists?.purchasetax_accounts ?? []).find(keineVorsteuer)
  if (!tax) return null
  return {
    cost_account_id: cost.id,
    purchasetax_account_id: tax.id,
    bank_account_id: csvBankId,
    tax_percent: 0,
    // As any suggestion: Privatentnahmen's own lock books 0 / 0 (lib/account-locks.ts),
    // and a row the owner moves to a business account books like any other expense
    deductibility_amount_percent: 100,
    deductible_share: 1,
    country: '',
    supplier_region: 'AT',
    vatin: '',
    title: 'Privatentnahme',
    category: 'Privatentnahme',
    reasoning: own.invoiceRef
      ? `⚠ Überweisung auf dein eigenes Konto, aber mit Rechnungsnummer „${own.invoiceRef}“ im Text — Auslagenersatz? Dann die Ausgabe selbst gesondert buchen.`
      : `Überweisung auf dein eigenes Konto (Inhaber ${own.holder}, IBAN …${own.iban.slice(-4)}) — Privatentnahme (feste Regel).`,
    requires_invoice: false,
    certainty: own.invoiceRef ? 'niedrig' : 'hoch',
    source: 'rule',
  }
}
