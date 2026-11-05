// The text of a document email, composed alike in the editor (browser) and on the server: pure,
// never creates a share link. Sending is src/lib/services/email.ts.
import { invoiceEmailTemplate } from '@/lib/document-labels'
import {
  documentVariables, fillSubject, fillTemplate, parseEmailList, resolveTemplate, templateLang, usesVariable,
  type TemplateDocument, type TemplateIssuer, type TemplateText,
} from '@/lib/templates'
import type { NamedClient } from '@/lib/utils/clients'
import type { DocumentType, InvoiceKind } from '@/types'

type EmailTemplateSettings = Parameters<typeof resolveTemplate>[0]

// Left in a text composed before the document has a link; filled when it is sent (fillPortalLink).
export const PORTAL_LINK_TOKEN = '{{portal_link}}'
const PORTAL_LINK = /\{\{\s*portal_link\s*\}\}/g

// The document's template in its own language; an advance, partial or final invoice's built-in
// text names it as such.
export function documentEmailTemplate(
  settings: EmailTemplateSettings,
  type: DocumentType,
  invoiceKind: InvoiceKind | null | undefined,
  language: string | null | undefined,
): TemplateText {
  const lang = templateLang(language)
  return type === 'invoice' ? invoiceEmailTemplate(settings, invoiceKind, lang) : resolveTemplate(settings, type, lang)
}

export function templateUsesPortalLink(tpl: TemplateText): boolean {
  return usesVariable(tpl.subject, 'portal_link') || usesVariable(tpl.body, 'portal_link')
}

export function hasPortalLinkToken(text: string): boolean {
  return new RegExp(PORTAL_LINK.source).test(text)
}

export function fillPortalLink(text: string, link: string): string {
  return text.replace(PORTAL_LINK, () => link)
}

// Subject and body for this document. Without `portalLink` the {{portal_link}} token stays in
// the text, to be filled with the link once it exists.
export function composeDocumentEmail({ tpl, doc, client, issuer, totals, portalLink }: {
  tpl: TemplateText
  doc: TemplateDocument
  client: NamedClient | null | undefined
  issuer: TemplateIssuer
  totals: { subtotal: number; total: number; balance_due: number }
  portalLink?: string
}): { subject: string; body: string } {
  const vars = documentVariables({ doc, client, issuer, totals, portalLink: portalLink ?? PORTAL_LINK_TOKEN })
  return { subject: fillSubject(tpl.subject, vars), body: fillTemplate(tpl.body, vars) }
}

// Every address the client record holds (its email and CC list), lower-case: an email to any
// other address is approved in Mado.
export function clientAddresses(client: { email?: string | null; cc_emails?: readonly string[] | null } | null | undefined): Set<string> {
  const { emails } = parseEmailList([client?.email ?? '', ...(client?.cc_emails ?? [])])
  return new Set(emails.map(a => a.toLowerCase()))
}

// Printable ASCII: text that public.mcp_address_set split and folded as this app does even before
// it spelled out its characters (outside a Turkish locale, where lower('I') is not 'i').
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

// The addresses in these values as public.mcp_address_set (20261105_mcp_drafts.sql) gives them:
// split on \s and , ; < >, with A-Z lower-cased and nothing else (the SQL spells out the same
// characters). An earlier version of the function folded with lower() and split on the locale's
// [[:space:]], so a mark it stored on text that is not printable ASCII may differ; heldBackAddress
// holds such text back instead of relying on the comparison.
export function mcpAddressSet(values: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set<string>()
  for (const value of values) {
    for (const part of (value ?? '').replace(/[A-Z]/g, c => c.toLowerCase()).split(/[\s,;<>]+/)) if (/^[\s\S]+@[\s\S]+$/.test(part)) out.add(part)
  }
  return out
}

// Why nothing may be sent unattended to an address value (a client's email field or one CC
// entry, as stored): 'written' when it names an address a Claude session wrote onto the client
// (clients.mcp_recipients, kept until the owner saves the client in Mado); 'unchecked' when the
// client has such marks and the value is not printable ASCII, where the app does not rely on
// matching the marks (see mcpAddressSet) and fails closed until the owner saves the client. A
// client read without the column (20261105_mcp_drafts.sql not applied) has no marks.
export function heldBackAddress(client: { mcp_recipients?: readonly string[] | null } | null | undefined): (value: string | null | undefined) => 'written' | 'unchecked' | null {
  const marked = new Set((Array.isArray(client?.mcp_recipients) ? client.mcp_recipients : []).filter((a): a is string => typeof a === 'string'))
  return value => {
    if (!marked.size) return null
    if ([...mcpAddressSet([value])].some(a => marked.has(a))) return 'written'
    return PRINTABLE_ASCII.test(value ?? '') ? null : 'unchecked'
  }
}

// The client's CC addresses that may get unattended mail (the reminder cron): the valid ones, less
// those heldBackAddress holds back, and how many were held back. A printable-ASCII entry is
// checked address by address (each is one part of it as the database split it); any other entry
// is checked whole, as stored.
export function unattendedCopies(client: { cc_emails?: readonly string[] | null; mcp_recipients?: readonly string[] | null }): { cc: string[]; heldBack: number } {
  const held = heldBackAddress(client)
  const entries = Array.isArray(client.cc_emails) ? client.cc_emails : []
  const kept = entries.flatMap(entry => PRINTABLE_ASCII.test(entry) ? parseEmailList(entry).emails.filter(a => !held(a)) : held(entry) ? [] : [entry])
  const cc = parseEmailList(kept).emails
  return { cc, heldBack: parseEmailList(entries).emails.length - cc.length }
}
