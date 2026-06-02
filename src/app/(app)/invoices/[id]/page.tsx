import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import DocumentStatusBar from '@/components/layout/DocumentStatusBar'
import DeleteDocumentButton from '@/components/layout/DeleteDocumentButton'
import DuplicateDocumentButton from '@/components/layout/DuplicateDocumentButton'
import InvoicePageClient from '@/components/layout/InvoicePageClient'
import ShareLinkButton from '@/components/layout/ShareLinkButton'
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
    supabase.from('catalogue_items').select('*').eq('active', true).order('sort_order'),
  ])

  if (!doc) notFound()

  const payments = doc.payments ?? []
  const docWithItems = { ...doc, items: doc.document_items ?? [], payments }
  const totals = calcTotals(doc.document_items ?? [], payments)

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/invoices" className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors shrink-0">
            <ArrowLeft size={16} />
          </Link>
          <h1 className="text-xl sm:text-2xl font-semibold truncate">{doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">Draft</span>}</h1>
        </div>
        <div className="flex items-center gap-2 pl-7 sm:pl-0">
          <DocumentStatusBar document={doc} />
          <div className="flex-1 sm:hidden" />
          <ShareLinkButton documentId={doc.id} initialToken={doc.share_token ?? null} driveConfigured={!!settings?.drive_folder_id} />
          <DuplicateDocumentButton docId={doc.id} docType="invoice" backTo="/invoices" />
          <DeleteDocumentButton id={doc.id} backTo="/invoices" docNumber={doc.number} docType="invoice" />
        </div>
      </div>
      <InvoicePageClient
        type="invoice"
        settings={settings!}
        clients={clients ?? []}
        catalogue={catalogue ?? []}
        document={docWithItems}
        total={totals.total}
        payments={payments}
        currency={doc.currency ?? 'EUR'}
        bookamatConfigured={!!(settings?.bookamat_username && settings?.bookamat_api_key && settings?.bookamat_bank_account_id)}
        bookamatBookingId={doc.bookamat_booking_id ?? null}
        reminderSentAt={doc.reminder_sent_at ?? null}
      />
    </div>
  )
}
