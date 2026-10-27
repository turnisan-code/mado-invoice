import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import DocumentBuilder from '@/components/forms/DocumentBuilder'
import DocumentStatusBar from '@/components/layout/DocumentStatusBar'
import ConvertToInvoiceButton from '@/components/layout/ConvertToInvoiceButton'
import ShareLinkButton from '@/components/layout/ShareLinkButton'
import IssuedPdfLink from '@/components/layout/IssuedPdfLink'
import DuplicateDocumentButton from '@/components/layout/DuplicateDocumentButton'
import DeleteDocumentButton from '@/components/layout/DeleteDocumentButton'
import { toPublicSettings } from '@/lib/public-settings'
import { formatDate } from '@/lib/utils/document'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const [{ data: doc }, { data: settings }, { data: clients }, { data: catalogue }] = await Promise.all([
    supabase.from('documents').select('*, document_items(*), payments(*)').eq('id', id).eq('type', 'quote').single(),
    supabase.from('settings').select('*').single(),
    supabase.from('clients').select('*').order('name'),
    supabase.from('catalogue_items').select('*').eq('active', true).order('sort_order'),
  ])

  if (!doc) notFound()

  const publicSettings = toPublicSettings(settings)
  const docWithItems = { ...doc, items: doc.document_items ?? [], payments: doc.payments ?? [] }

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/quotes" aria-label="Back to quotes" className="h-11 w-11 -m-3.5 inline-flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors shrink-0">
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
          {!['accepted', 'rejected', 'cancelled'].includes(doc.status) && (
            <ConvertToInvoiceButton quoteId={doc.id} />
          )}
          <DuplicateDocumentButton docId={doc.id} docType="quote" backTo="/quotes" />
          <DeleteDocumentButton id={doc.id} backTo="/quotes" docNumber={doc.number} docType="quote" />
        </div>
      </div>
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6">
        <DocumentBuilder
          type="quote"
          settings={publicSettings}
          clients={clients ?? []}
          catalogue={catalogue ?? []}
          document={docWithItems}
        />
      </div>
    </div>
  )
}
