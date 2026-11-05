import type { SupabaseClient } from '@supabase/supabase-js'
import { documentLanguage, documentT } from '@/lib/document-labels'
import { loadPdfDocument, loadSettings } from '@/lib/pdf/render'
import { getIssuedPdf } from '@/lib/pdf/snapshot'
import { fetchBuyerReference, fetchCreditReference } from '@/lib/utils/document-reference'
import type { EInvoiceFormat } from '@/types'
import { EInvoiceError, buildEInvoice, einvoiceFilename, withAttachment, type PrecedingInvoice } from './common'
import { toEbInterface } from './ebinterface'
import { toUbl } from './ubl'

// Server-only: the e-invoice of an issued invoice or credit note, built from the stored document,
// with the buyer reference the PDF and the portal print (fetchBuyerReference). Peppol embeds the
// issued PDF; it is only fetched (and, for a document issued before archive copies existed, stored)
// once the XML is known to be valid.
export async function exportEInvoice(supabase: SupabaseClient, documentId: string, format: EInvoiceFormat) {
  const [doc, settings] = await Promise.all([loadPdfDocument(supabase, documentId), loadSettings(supabase)])
  if (!doc.clients) throw new Error('Document has no client')
  if (!doc.number) throw new EInvoiceError('not_issued', 'Only issued documents can be e-invoices')

  const buyerReference = await fetchBuyerReference(supabase, doc, doc.clients)

  // A final invoice references the advance and partial invoices it deducts.
  let preceding: PrecedingInvoice[] = []
  if (doc.type === 'invoice' && doc.invoice_kind === 'final') {
    const { data, error } = await supabase.from('documents').select('number, date, invoice_kind')
      .eq('final_invoice_id', doc.id).not('number', 'is', null).order('date').order('number')
    if (error) throw new Error(error.message)
    preceding = (data ?? []).map(d => ({ number: d.number as string, date: d.date as string, kind: d.invoice_kind === 'partial' ? 'partial' : 'advance' }))
  }

  const inv = buildEInvoice({
    doc,
    items: doc.document_items ?? [],
    payments: doc.payments ?? [],
    client: doc.clients,
    settings,
    reference: await fetchCreditReference(supabase, doc),
    buyerReference,
    preceding,
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
