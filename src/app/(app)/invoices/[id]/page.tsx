import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import DocumentStatusBar from '@/components/layout/DocumentStatusBar'
import DeleteDocumentButton from '@/components/layout/DeleteDocumentButton'
import DuplicateDocumentButton from '@/components/layout/DuplicateDocumentButton'
import InvoicePageClient from '@/components/layout/InvoicePageClient'
import ShareLinkButton from '@/components/layout/ShareLinkButton'
import IssuedPdfLink from '@/components/layout/IssuedPdfLink'
import ConvertToCreditNoteButton from '@/components/layout/ConvertToCreditNoteButton'
import { calcTotals, formatDate } from '@/lib/utils/document'
import { toPublicSettings } from '@/lib/public-settings'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const [{ data: doc }, { data: settings }, { data: clients }, { data: catalogue }, { data: reminderLog }] = await Promise.all([
    supabase.from('documents').select('*, document_items(*), payments(*)').eq('id', id).eq('type', 'invoice').single(),
    supabase.from('settings').select('*').single(),
    supabase.from('clients').select('*').order('name'),
    supabase.from('catalogue_items').select('*').eq('active', true).order('sort_order'),
    supabase.from('reminder_log').select('*').eq('document_id', id).order('sent_at', { ascending: false }),
  ])

  if (!doc) notFound()

  const publicSettings = toPublicSettings(settings)
  const payments = doc.payments ?? []
  const docWithItems = { ...doc, items: doc.document_items ?? [], payments }
  const totals = calcTotals(
    doc.document_items ?? [],
    payments,
    doc.discount_type && doc.discount_value ? { type: doc.discount_type as 'percent' | 'fixed', value: doc.discount_value } : null,
    doc.tax_treatment,
  )

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/invoices" aria-label="Back to invoices" className="h-11 w-11 -m-3.5 inline-flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors shrink-0">
            <ArrowLeft size={16} />
          </Link>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold truncate">{doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">Draft</span>}</h1>
            {doc.issued_at && <p className="text-xs text-neutral-500 dark:text-neutral-400">Issued {formatDate(doc.issued_at)}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2 pl-7 sm:pl-0">
          <DocumentStatusBar document={doc} />
          {doc.pdf_path && <IssuedPdfLink documentId={doc.id} />}
          <div className="flex-1 sm:hidden" />
          {doc.number && <ShareLinkButton documentId={doc.id} initialToken={doc.share_token ?? null} driveConfigured={!!publicSettings.drive_folder_id} />}
          <ConvertToCreditNoteButton invoiceId={doc.id} />
          <DuplicateDocumentButton docId={doc.id} docType="invoice" backTo="/invoices" />
          <DeleteDocumentButton id={doc.id} backTo="/invoices" docNumber={doc.number} docType="invoice" />
        </div>
      </div>
      <InvoicePageClient
        type="invoice"
        settings={publicSettings}
        clients={clients ?? []}
        catalogue={catalogue ?? []}
        document={docWithItems}
        total={totals.total}
        payments={payments}
        currency={doc.currency ?? 'EUR'}
        bookamatConfigured={publicSettings.bookamat_configured && !!publicSettings.bookamat_bank_account_id}
        bookamatBookingId={doc.bookamat_booking_id ?? null}
        reminderSentAt={doc.reminder_sent_at ?? null}
        reminderLevel={doc.reminder_level ?? 0}
        reminderLog={reminderLog ?? []}
      />
    </div>
  )
}
