import type { SupabaseClient } from '@supabase/supabase-js'
import { documentLanguage, documentT } from '@/lib/document-labels'
import { loadPdfDocument, loadSettings } from '@/lib/pdf/render'
import { getIssuedPdf } from '@/lib/pdf/snapshot'
import { fetchCreditReference } from '@/lib/utils/document-reference'
import type { EInvoiceFormat } from '@/types'
import { EInvoiceError, buildEInvoice, einvoiceFilename, withAttachment } from './common'
import { toEbInterface } from './ebinterface'
import { toUbl } from './ubl'

// Server-only: the e-invoice of an issued invoice or credit note, built from the stored document.
// The buyer reference is the document's own; while it was never set (null, unlike an explicitly
// cleared ''), that of the invoice a credit note corrects, else the client's default. Peppol embeds
// the issued PDF; it is only fetched (and, for a document issued before archive copies existed,
// stored) once the XML is known to be valid.
export async function exportEInvoice(supabase: SupabaseClient, documentId: string, format: EInvoiceFormat) {
  const [doc, settings] = await Promise.all([loadPdfDocument(supabase, documentId), loadSettings(supabase)])
  if (!doc.clients) throw new Error('Document has no client')
  if (!doc.number) throw new EInvoiceError('not_issued', 'Only issued documents can be e-invoices')

  let buyerReference = doc.buyer_reference?.trim() || null
  if (doc.buyer_reference == null) {
    const sourceId = doc.type === 'credit_note' ? doc.cancels_document_id ?? doc.converted_from_id : null
    if (sourceId) {
      const { data } = await supabase.from('documents').select('buyer_reference').eq('id', sourceId).maybeSingle()
      buyerReference = data?.buyer_reference?.trim() || null
    }
    buyerReference ??= doc.clients.buyer_reference?.trim() || null
  }

  const inv = buildEInvoice({
    doc,
    items: doc.document_items ?? [],
    payments: doc.payments ?? [],
    client: doc.clients,
    settings,
    reference: await fetchCreditReference(supabase, doc),
    buyerReference,
    t: documentT(documentLanguage(doc.language)),
  })

  let xml: string
  let attached = false
  if (format === 'ubl') {
    toUbl(inv)
    let pdf: { filename: string; base64: string } | null = null
    try {
      const issued = await getIssuedPdf(supabase, documentId, 'on_demand')
      pdf = { filename: issued.filename, base64: issued.buffer.toString('base64') }
    } catch (err) {
      console.error(`[einvoice] ${doc.number}: issued PDF unavailable, exported without it:`, err)
    }
    xml = toUbl(withAttachment(inv, pdf))
    attached = !!pdf
  } else {
    xml = toEbInterface(inv)
  }

  return { xml, filename: einvoiceFilename(doc.number, format), number: doc.number, attached }
}
