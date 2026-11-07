// Emailing an issued document from the connected Gmail account: the frozen PDF, optionally the
// client's e-invoice, then the history and, when asked, the Drive copy. Server only (googleapis,
// the PDF renderer). The text is composed by email-compose.ts.
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAuthorizedGoogle, googleFailure, type GoogleFailure } from '@/lib/google/client'
import { sendGmail, ensurePortalLink, type MailAttachment } from '@/lib/utils/reminder'
import { logEvent } from '@/lib/events'
import { getIssuedPdf, type IssuedPdf } from '@/lib/pdf/snapshot'
import { archiveToDrive, type DriveArchive } from '@/lib/pdf/drive'
import { withCancelStamp } from '@/lib/pdf/stamp'
import { exportEInvoice } from '@/lib/einvoice/export'
import type { EInvoiceFormat, Settings } from '@/types'
import { fillPortalLink, hasPortalLinkToken } from './email-compose'

export {
  clientAddresses, composeDocumentEmail, documentEmailTemplate, fillPortalLink, hasPortalLinkToken,
  PORTAL_LINK_TOKEN, templateUsesPortalLink,
} from './email-compose'

// CC and BCC together; Gmail and the recipients' servers treat more as a mass mailing.
export const MAX_COPIES = 20

export interface DocumentEmail {
  // Without one nothing is attached and no history is written.
  documentId: string | null
  to: readonly string[]
  cc: readonly string[]
  bcc: readonly string[]
  subject: string
  body: string
  einvoice: EInvoiceFormat | null
  // Archive the frozen PDF to Drive after sending (never overwrites an archived file).
  uploadToDrive?: boolean
  // Fill a {{portal_link}} left in the text with the document's client-portal link, created on
  // first use; without an origin the text is sent as it is.
  portalOrigin?: string | null
  // An email Claude prepared: the e-invoice waits for a client or an invoice's payments a Claude
  // session changed and the owner has not saved or confirmed (exportEInvoice), nothing is sent.
  claudeHold?: boolean
}

export type EInvoiceAttachment = MailAttachment & { format: EInvoiceFormat; number: string; pdfEmbedded: boolean }

export type SentEmail = {
  ok: true
  attachments: string[]
  einvoice: { format: EInvoiceFormat; filename: string } | null
  drive: DriveArchive | null
  driveError: { error: string; code: string } | null
}

// Where sending stopped; nothing was sent in any of these.
export type EmailFailure =
  | { ok: false; stage: 'pdf' | 'einvoice' | 'portal_link'; error: unknown }
  | { ok: false; stage: 'send'; failure: GoogleFailure }

// The attachment is always the document's frozen copy, never a PDF a caller supplies (with the
// cancelled stamp over it when the document is cancelled; the Drive copy gets the copy as issued);
// the e-invoice is built from the stored document as the download is. A failure before the send
// leaves nothing sent; after it the email is out, and the history and Drive copy are best effort.
export async function sendDocumentEmail(supabase: SupabaseClient, settings: Settings, mail: DocumentEmail): Promise<SentEmail | EmailFailure> {
  const { documentId } = mail
  let issued: IssuedPdf | null = null
  let attachment: MailAttachment | null = null
  if (documentId) {
    try {
      issued = await getIssuedPdf(supabase, documentId, 'on_demand')
      const pdf = await withCancelStamp(supabase, issued.doc, issued.buffer)
      attachment = { filename: issued.filename, content: Buffer.from(pdf) }
    } catch (error) {
      return { ok: false, stage: 'pdf', error }
    }
  }

  let xml: EInvoiceAttachment | null = null
  if (mail.einvoice && documentId) {
    try {
      const built = await exportEInvoice(supabase, documentId, mail.einvoice, { claudeHold: !!mail.claudeHold })
      xml = { filename: built.filename, content: Buffer.from(built.xml, 'utf8'), contentType: 'application/xml', format: mail.einvoice, number: built.number, pdfEmbedded: built.attached }
    } catch (error) {
      return { ok: false, stage: 'einvoice', error }
    }
  }

  let { subject, body } = mail
  if (mail.portalOrigin && issued && (hasPortalLinkToken(subject) || hasPortalLinkToken(body))) {
    try {
      const link = await ensurePortalLink(supabase, issued.doc, mail.portalOrigin)
      subject = fillPortalLink(subject, link)
      body = fillPortalLink(body, link)
    } catch (error) {
      return { ok: false, stage: 'portal_link', error }
    }
  }

  const to = mail.to.map(a => a.trim()).join(', ')
  try {
    await sendGmail(getAuthorizedGoogle(settings, supabase), {
      from: settings.gmail_email!,
      to,
      cc: mail.cc,
      bcc: mail.bcc,
      subject,
      body,
      attachments: [attachment, xml].filter(a => a !== null),
    })
  } catch (err) {
    return { ok: false, stage: 'send', failure: await googleFailure(err, supabase, settings.id, 'gmail/send') }
  }

  if (documentId) {
    const { error } = await supabase.from('documents')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', documentId)
      .is('sent_at', null)
    if (error) console.error('[gmail/send] sent_at not recorded:', error.message)
    await logEvent(supabase, documentId, 'emailed', {
      to,
      ...(mail.cc.length ? { cc: mail.cc } : {}),
      ...(mail.bcc.length ? { bcc: mail.bcc } : {}),
      subject,
      attachment: attachment?.filename ?? null,
      ...(xml ? { einvoice: xml.filename } : {}),
    })
    if (xml) await logEvent(supabase, documentId, 'einvoice_exported', { format: xml.format, number: xml.number, pdf: xml.pdfEmbedded, emailed: to })
  }

  const sent: SentEmail = {
    ok: true,
    attachments: [attachment, xml].filter(a => a !== null).map(a => a.filename),
    einvoice: xml ? { format: xml.format, filename: xml.filename } : null,
    drive: null,
    driveError: null,
  }
  if (mail.uploadToDrive && issued && issued.doc.number && settings.drive_folder_id && settings.gmail_refresh_token) {
    try {
      sent.drive = await archiveToDrive(supabase, issued.settings, { ...issued.doc, number: issued.doc.number }, issued)
    } catch (err) {
      const failure = await googleFailure(err, supabase, settings.id, 'drive-pdf')
      sent.driveError = { error: failure.error, code: failure.code }
    }
  }
  return sent
}
