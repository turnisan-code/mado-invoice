import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import DocumentBuilder from '@/components/forms/DocumentBuilder'
import DocumentStatusBar from '@/components/layout/DocumentStatusBar'
import DeleteDocumentButton from '@/components/layout/DeleteDocumentButton'
import DuplicateDocumentButton from '@/components/layout/DuplicateDocumentButton'
import PaymentPanel, { type BookamatPdfData } from '@/components/layout/PaymentPanel'
import { calcTotals } from '@/lib/utils/document'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const [{ data: doc }, { data: settings }, { data: clients }, { data: catalogue }] = await Promise.all([
    supabase.from('documents').select('*, document_items(*), payments(*)').eq('id', id).single(),
    supabase.from('settings').select('*').single(),
    supabase.from('clients').select('*').order('name'),
    supabase.from('catalogue_items').select('*').order('sort_order'),
  ])

  if (!doc) notFound()

  const payments = doc.payments ?? []
  const docWithItems = { ...doc, items: doc.document_items ?? [], payments }
  const totals = calcTotals(doc.document_items ?? [], payments)

  const client = clients?.find(c => c.id === doc.client_id) ?? null
  const bookamatPdfData: BookamatPdfData | undefined = settings && client ? {
    // Strip logo_url — image loading inside react-pdf's web worker can crash
    settings: { ...settings, logo_url: null },
    client,
    document: {
      number: doc.number ?? '',
      date: doc.date,
      service_date: doc.service_date,
      due_date: doc.due_date,
      type: doc.type,
      language: doc.language,
      currency: doc.currency,
      tax_treatment: doc.tax_treatment,
      notes: doc.notes,
      tax_note: null,
      discount_type: doc.discount_type,
      discount_value: doc.discount_value,
      items: (doc.document_items ?? []).map((i: typeof doc.document_items[number]) => ({
        line_type: i.line_type,
        description: i.description,
        service_date: i.service_date,
        quantity: i.quantity,
        unit: i.unit,
        unit_price: i.unit_price,
        vat_rate: i.vat_rate,
      })),
      totals,
    },
  } : undefined

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/invoices" className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors">
          <ArrowLeft size={16} />
        </Link>
        <h1 className="text-2xl font-semibold">{doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">Draft</span>}</h1>
        <DocumentStatusBar document={doc} />
        <DuplicateDocumentButton docId={doc.id} docType="invoice" backTo="/invoices" />
        <DeleteDocumentButton id={doc.id} backTo="/invoices" docNumber={doc.number} docType="invoice" />
      </div>
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6">
        <DocumentBuilder
          type="invoice"
          settings={settings!}
          clients={clients ?? []}
          catalogue={catalogue ?? []}
          document={docWithItems}
        />
      </div>
      <PaymentPanel
        documentId={doc.id}
        total={totals.total}
        payments={payments}
        currency={doc.currency ?? 'EUR'}
        bookamatConfigured={!!(settings?.bookamat_username && settings?.bookamat_api_key && settings?.bookamat_bank_account_id)}
        bookamatBookingId={doc.bookamat_booking_id ?? null}
        bookamatPdfData={bookamatPdfData}
      />
    </div>
  )
}
