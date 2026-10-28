import path from 'path'
import { createElement, type ComponentProps } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import type { SupabaseClient } from '@supabase/supabase-js'
import InvoiceDocument from '@/components/pdf/InvoiceDocument'
import { registerPdfFonts } from '@/components/pdf/fonts'
import { calcTotals, getTaxNote, orderItems } from '@/lib/utils/document'
import { fetchCreditReference } from '@/lib/utils/document-reference'
import { epcBeneficiary, generateEpcQr } from '@/lib/utils/epc-qr'
import type { Client, Document, DocumentItem, Language, Payment, Settings } from '@/types'

// Server-only (renderToBuffer needs node): import from route handlers and server utilities,
// never from a client component.

// next.config.ts traces public/fonts into every function that renders.
registerPdfFonts(path.join(process.cwd(), 'public', 'fonts'))

export type PdfDocument = Document & {
  document_items: DocumentItem[] | null
  payments: Payment[] | null
  clients: Client | null
}

type InvoiceDocumentProps = ComponentProps<typeof InvoiceDocument>
type PdfElement = Parameters<typeof renderToBuffer>[0]

export class DocumentNotFoundError extends Error {}

export async function loadPdfDocument(supabase: SupabaseClient, documentId: string): Promise<PdfDocument> {
  const { data, error } = await supabase
    .from('documents')
    .select('*, document_items(*), payments(*), clients(*)')
    .eq('id', documentId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new DocumentNotFoundError('Document not found')
  return data as PdfDocument
}

export async function loadSettings(supabase: SupabaseClient): Promise<Settings> {
  const { data, error } = await supabase.from('settings').select('*').single()
  if (error || !data) throw new Error(error?.message ?? 'Settings not found')
  return data as Settings
}

export function pdfFilename(number: string): string {
  return `${number.replace(/["\\/\r\n]+/g, '_')}.pdf`
}

// The single assembly of everything the PDF prints: ordered lines, totals after payments and
// section discounts, the tax note with the settings overrides, the Storno or correction reference
// and, for a EUR invoice with an open balance, the EPC payment QR.
export async function renderLoadedPdf(
  supabase: SupabaseClient,
  doc: PdfDocument,
  settings: Settings,
  { includeQr = true }: { includeQr?: boolean } = {},
): Promise<Buffer> {
  if (!doc.clients) throw new Error('Document has no client')
  const items = orderItems(doc.document_items ?? [])
  const discount = doc.discount_type && doc.discount_value ? { type: doc.discount_type, value: doc.discount_value } : null
  const totals = calcTotals(items, doc.payments ?? [], discount, doc.tax_treatment)
  const lang: Language = doc.language === 'en' ? 'en' : 'de'
  const number = doc.number ?? ''

  // EUR only: the QR is a SEPA transfer of the open balance.
  const qrCodeDataUri = includeQr && doc.type === 'invoice' && doc.currency === 'EUR' && settings.iban && totals.balance_due > 0
    ? await generateEpcQr({
        iban: settings.iban,
        bic: settings.bic ?? '',
        name: epcBeneficiary(settings),
        amountEur: totals.balance_due,
        reference: number,
      })
    : null

  const props: InvoiceDocumentProps = {
    settings,
    client: doc.clients,
    qrCodeDataUri,
    document: {
      number,
      date: doc.date,
      service_date: doc.service_date,
      service_date_end: doc.service_date_end ?? null,
      due_date: doc.due_date,
      type: doc.type,
      language: lang,
      currency: doc.currency ?? 'EUR',
      tax_treatment: doc.tax_treatment ?? 'at_vat',
      notes: doc.notes,
      tax_note: getTaxNote(doc.tax_treatment ?? 'at_vat', lang, settings),
      discount_type: doc.discount_type,
      discount_value: doc.discount_value,
      skonto_percent: doc.skonto_percent ?? null,
      skonto_days: doc.skonto_days ?? null,
      items,
      totals,
      reference: await fetchCreditReference(supabase, doc),
    },
  }

  return renderToBuffer(createElement(InvoiceDocument, props) as unknown as PdfElement)
}

export async function renderDocumentPdf(
  supabase: SupabaseClient,
  documentId: string,
  opts: { includeQr?: boolean } = {},
): Promise<{ buffer: Buffer; filename: string; doc: PdfDocument; settings: Settings }> {
  const [doc, settings] = await Promise.all([loadPdfDocument(supabase, documentId), loadSettings(supabase)])
  const buffer = await renderLoadedPdf(supabase, doc, settings, opts)
  return { buffer, filename: pdfFilename(doc.number ?? 'draft'), doc, settings }
}
