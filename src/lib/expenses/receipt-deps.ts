// What the receipt routes read Gmail and PDFs with (PR 9b): Mado's Google connection (with
// gmail.readonly, decision D4) and Claude Opus 5.5 (decision D3). Server only; it loads
// googleapis and Next (lib/google/client.ts), so the engine's tests pass stand-ins instead.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Settings } from '@/types'
import {
  getAuthorizedGoogle, googleFailure, isGoogleScopeError, recordGoogleError,
} from '@/lib/google/client'
import { GMAIL_READONLY_SCOPE, GOOGLE_GMAIL_READ_MESSAGE, GOOGLE_NOT_CONNECTED_MESSAGE, GOOGLE_REAUTH_CODE } from '@/lib/google/reauth'
import { expenseOwnerOf, setExpenseOwner } from './owner'
import { gmailApiOf, gmailSearches } from './gmail'
import { gmailReceiptDeps, pdfTextOf, type GmailReceiptDeps } from './gmail-receipt'
import { pdfReaderConfigured, readPdfInvoice, ReceiptUnreadableError } from './pdf-reader'
import type { AttachDeps } from './receipts'

export { GMAIL_READONLY_SCOPE }
export const RECEIPT_SETTINGS_COLUMNS = 'id, gmail_email, gmail_access_token, gmail_refresh_token, gmail_token_expiry, gmail_scopes, uid_number, owner_name, iban, own_ibans, expenses_from'
export type ReceiptSettings = Pick<Settings, 'id' | 'gmail_email' | 'gmail_access_token' | 'gmail_refresh_token' | 'gmail_token_expiry' | 'gmail_scopes' | 'uid_number' | 'owner_name' | 'iban'>
  & { own_ibans?: string[] | null; expenses_from?: string | null }

export const READER_MISSING = 'Claude ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt) — Beleg nicht gelesen'
// „Anhängen“'s read: as Bookmatic's (25 s, one retry)
const ATTACH_READ = { timeoutMs: 25_000, maxRetries: 1 }

// Why Gmail can't be read for receipts, as the routes answer it: not connected, or a grant from
// before gmail.readonly
export function gmailReadRefusal(settings: ReceiptSettings): { status: number; error: string; code: string } | null {
  if (!settings.gmail_refresh_token) return { status: 400, error: GOOGLE_NOT_CONNECTED_MESSAGE, code: GOOGLE_REAUTH_CODE }
  if (!(settings.gmail_scopes ?? '').split(/\s+/).includes(GMAIL_READONLY_SCOPE)) return { status: 403, error: GOOGLE_GMAIL_READ_MESSAGE, code: GOOGLE_REAUTH_CODE }
  return null
}

function gmailOf(settings: ReceiptSettings, supabase: SupabaseClient) {
  setExpenseOwner(expenseOwnerOf(settings))
  return gmailApiOf(getAuthorizedGoogle(settings, supabase))
}

// A line's search: Gmail, the PDF text, Claude's read — without ANTHROPIC_API_KEY every read
// fails as „nicht lesbar“ and says why
export function searchDeps(settings: ReceiptSettings, supabase: SupabaseClient): GmailReceiptDeps {
  const deps = gmailReceiptDeps(gmailOf(settings, supabase), settings.uid_number ?? '')
  return pdfReaderConfigured() ? deps : { ...deps, readPdf: async () => { throw new ReceiptUnreadableError(READER_MISSING) } }
}

// „Anhängen“: the part from Gmail, its text, Claude's read (none without the key)
export function attachDeps(settings: ReceiptSettings, supabase: SupabaseClient): AttachDeps {
  const searches = gmailSearches(gmailOf(settings, supabase))
  return {
    fetchPdf: (messageId, partId) => searches.getPdfAttachment(messageId, partId),
    pdfText: pdfTextOf,
    readPdf: async base64 => (pdfReaderConfigured() ? readPdfInvoice(base64, { ...ATTACH_READ, ownVatin: settings.uid_number ?? '' }) : null),
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
