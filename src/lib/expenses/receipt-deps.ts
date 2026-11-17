// What the receipt routes read Gmail and PDFs with (PR 9b): Mado's Google connection (with
// gmail.readonly, decision D4) and Claude Opus 5.5 (decision D3). Server only; it loads
// googleapis and Next (lib/google/client.ts), so the engine's tests pass stand-ins instead.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Settings } from '@/types'
import {
  getAuthorizedGoogle, getOAuthClient, googleFailure, isGoogleScopeError, recordGoogleError,
} from '@/lib/google/client'
import { GMAIL_READONLY_SCOPE, GOOGLE_GMAIL_READ_MESSAGE, GOOGLE_NOT_CONNECTED_MESSAGE, GOOGLE_REAUTH_CODE } from '@/lib/google/reauth'
import { expenseOwnerOf, setExpenseOwner } from './owner'
import { gmailApiOf, gmailSearches } from './gmail'
import { gmailReceiptDeps, pdfTextOf, type GmailReceiptDeps } from './gmail-receipt'
import { pdfReaderConfigured, readPdfInvoice, ReceiptUnreadableError } from './pdf-reader'
import type { AccountGate, AttachDeps } from './receipts'
import { accountGate } from './statement'
import { readBankAccounts } from './accounts'
import { credentialsOf } from '@/lib/bookamat'

export { GMAIL_READONLY_SCOPE }
export const RECEIPT_SETTINGS_COLUMNS = 'id, gmail_email, gmail_access_token, gmail_refresh_token, gmail_token_expiry, gmail_scopes, uid_number, owner_name, iban, own_ibans, expenses_from, bookamat_username, bookamat_api_key, bookamat_country'
export type ReceiptSettings = Pick<Settings, 'id' | 'gmail_email' | 'gmail_access_token' | 'gmail_refresh_token' | 'gmail_token_expiry' | 'gmail_scopes' | 'uid_number' | 'owner_name' | 'iban' | 'bookamat_username' | 'bookamat_api_key' | 'bookamat_country'>
  & { own_ibans?: string[] | null; expenses_from?: string | null }

export const READER_MISSING = 'Claude ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt) — Beleg nicht gelesen'
// „Anhängen“'s read: 20 s, one retry (both within the route's 50 s with the Gmail fetch)
const ATTACH_READ = { timeoutMs: 20_000, maxRetries: 1 }
// What „Anhängen“ may take in all (maxDuration 60 s: the copy is stored after)
export const ATTACH_DEADLINE_MS = 50_000

// Why Gmail can't be read for receipts, as the routes answer it: not connected, or a grant from
// before gmail.readonly
export function gmailReadRefusal(settings: ReceiptSettings): { status: number; error: string; code: string } | null {
  if (!settings.gmail_refresh_token) return { status: 400, error: GOOGLE_NOT_CONNECTED_MESSAGE, code: GOOGLE_REAUTH_CODE }
  if (!(settings.gmail_scopes ?? '').split(/\s+/).includes(GMAIL_READONLY_SCOPE)) return { status: 403, error: GOOGLE_GMAIL_READ_MESSAGE, code: GOOGLE_REAUTH_CODE }
  return null
}

// The Gmail API of the owner's grant. `persist` false (a dry run): a token refreshed on the way is
// used and not written back, so the dry run writes nothing
function gmailOf(settings: ReceiptSettings, supabase: SupabaseClient, persist = true) {
  setExpenseOwner(expenseOwnerOf(settings))
  if (persist) return gmailApiOf(getAuthorizedGoogle(settings, supabase))
  const auth = getOAuthClient()
  auth.setCredentials({ access_token: settings.gmail_access_token, refresh_token: settings.gmail_refresh_token, expiry_date: settings.gmail_token_expiry })
  return gmailApiOf(auth)
}

// A line's search: Gmail, the PDF text, Claude's read — without ANTHROPIC_API_KEY every read
// fails as „nicht lesbar“ and says why
export function searchDeps(settings: ReceiptSettings, supabase: SupabaseClient, opts: { dryRun?: boolean } = {}): GmailReceiptDeps {
  const deps = gmailReceiptDeps(gmailOf(settings, supabase, !opts.dryRun), settings.uid_number ?? '')
  return pdfReaderConfigured() ? deps : { ...deps, readPdf: async () => { throw new ReceiptUnreadableError(READER_MISSING) } }
}

// „Anhängen“: the part from Gmail, its text, Claude's read (none without the key) — all within
// `signal` (the route's 50 s): a read cut off is „nicht lesbar“, and the PDF is attached anyway
export function attachDeps(settings: ReceiptSettings, supabase: SupabaseClient, signal: AbortSignal): AttachDeps {
  const searches = gmailSearches(gmailOf(settings, supabase))
  return {
    fetchPdf: (messageId, partId) => searches.getPdfAttachment(messageId, partId, { signal }),
    pdfText: pdfTextOf,
    readPdf: async base64 => (pdfReaderConfigured() ? readPdfInvoice(base64, { ...ATTACH_READ, signal, ownVatin: settings.uid_number ?? '' }) : null),
  }
}

// The PDF of a part, for „Vorschau“
export const previewDeps = (settings: ReceiptSettings, supabase: SupabaseClient) => gmailSearches(gmailOf(settings, supabase))

// A Gmail error a search or a fetch met: a grant that is gone clears the tokens (as every Google
// call does); one that lacks gmail.readonly is said, and sending and Drive keep working
export async function recordGmailError(err: unknown, supabase: SupabaseClient, settingsId: string): Promise<void> {
  if (isGoogleScopeError(err)) await recordGoogleError(supabase, settingsId, GOOGLE_GMAIL_READ_MESSAGE)
  else await googleFailure(err, supabase, settingsId, 'receipts')
}

// The line's account and currency as the booking checks them (lib/expenses/statement.ts
// accountGate): the owner's IBANs first; Bookamat's Zahlungsmittelkonten only when they don't
// name it. A Bookamat that can't be read leaves the line unsearched rather than guessed.
export function receiptAccountGate(settings: ReceiptSettings): AccountGate {
  return async (tx, year) => {
    const own = accountGate(settings, tx, null)
    if (!own || !own.startsWith('Konto ')) return own
    try {
      return accountGate(settings, tx, { bank_accounts: await readBankAccounts(credentialsOf(settings), year) })
    } catch {
      return own
    }
  }
}
