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

// The addresses in these values, split and lower-cased exactly as public.mcp_address_set
// (20261105_mcp_drafts.sql) does, so they compare with clients.mcp_recipients.
export function mcpAddressSet(values: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set<string>()
  for (const value of values) {
    for (const part of (value ?? '').toLowerCase().split(/[\s,;<>]+/)) if (/^.+@.+$/.test(part)) out.add(part)
  }
  return out
}

// Whether an address is one a Claude session wrote onto the client's email or CC list
// (clients.mcp_recipients, kept until the owner saves the client in Mado); nothing is sent to such
// an address unattended. A client read without the column (20261105_mcp_drafts.sql not applied)
// has none. (Parts are split on whitespace first, so '.' matches any character left.)
export function claudeWrittenAddresses(client: { mcp_recipients?: readonly string[] | null } | null | undefined): (value: string | null | undefined) => boolean {
  const marked = mcpAddressSet(Array.isArray(client?.mcp_recipients) ? client.mcp_recipients : [])
  return value => marked.size > 0 && [...mcpAddressSet([value])].some(a => marked.has(a))
}
