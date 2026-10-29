import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import DocumentBuilder from '@/components/forms/DocumentBuilder'
import DocumentStatusBar from '@/components/layout/DocumentStatusBar'
import DeleteDocumentButton from '@/components/layout/DeleteDocumentButton'
import DuplicateDocumentButton from '@/components/layout/DuplicateDocumentButton'
import ShareLinkButton from '@/components/layout/ShareLinkButton'
import IssuedPdfLink from '@/components/layout/IssuedPdfLink'
import EInvoiceButton from '@/components/layout/EInvoiceButton'
import SettingsMissing from '@/components/layout/SettingsMissing'
import DocumentHistory from '@/components/layout/DocumentHistory'
import CreditNoteSettlement from '@/components/layout/CreditNoteSettlement'
import { loadCreditNoteSettlement } from '@/lib/credits'
import { toPublicSettings } from '@/lib/public-settings'
import { formatDate } from '@/lib/utils/document'
import { fetchCreditReference } from '@/lib/utils/document-reference'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { getT } from '@/lib/i18n/server'

export default async function CreditNoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { t, lang } = await getT()

  const [{ data: doc }, { data: settings }, { data: clients }, { data: catalogue }] = await Promise.all([
    supabase.from('documents').select('*, document_items(*), payments(*)').eq('id', id).eq('type', 'credit_note').single(),
    supabase.from('settings').select('*').single(),
    supabase.from('clients').select('*').order('name'),
    supabase.from('catalogue_items').select('*').eq('active', true).order('sort_order'),
  ])

  if (!doc) notFound()
  if (!settings) return <SettingsMissing />

  const publicSettings = toPublicSettings(settings)
  // A Storno prints the cancelled invoice, a plain credit note the invoice it corrects.
  const reference = await fetchCreditReference(supabase, doc)
  const settlement = await loadCreditNoteSettlement(supabase, doc)
  const docWithItems = { ...doc, items: doc.document_items ?? [], payments: doc.payments ?? [] }

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/credit-notes" aria-label={t('documents.backToCreditNotes')} className="h-11 w-11 -m-3.5 inline-flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors shrink-0">
            <ArrowLeft size={16} />
          </Link>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold truncate">{doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">{t('common.draft')}</span>}</h1>
            {doc.issued_at && <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('documents.issued', { date: formatDate(doc.issued_at, lang) })}</p>}
          </div>
          {reference && reference.kind !== 'correction' && <span className="text-xs text-neutral-400 dark:text-neutral-500 shrink-0">{t('documents.stornoOf', { number: reference.number })}</span>}
        </div>
        <div className="flex items-center gap-2 pl-7 sm:pl-0">
          <DocumentStatusBar document={doc} display={settlement.settled ? 'settled' : undefined} />
          {doc.pdf_path && <IssuedPdfLink documentId={doc.id} driveFileId={doc.drive_file_id} />}
          <div className="flex-1 sm:hidden" />
          {doc.number && <ShareLinkButton documentId={doc.id} initialToken={doc.share_token ?? null} driveConfigured={!!publicSettings.drive_folder_id} />}
          {doc.number && <EInvoiceButton documentId={doc.id} compact />}
          <DuplicateDocumentButton docId={doc.id} docType="credit_note" backTo="/credit-notes" />
          <DeleteDocumentButton id={doc.id} backTo="/credit-notes" docNumber={doc.number} docType="credit_note" />
        </div>
      </div>
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6">
        <DocumentBuilder
          type="credit_note"
          settings={publicSettings}
          clients={clients ?? []}
          catalogue={catalogue ?? []}
          document={docWithItems}
          reference={reference}
        />
      </div>
      {doc.status !== 'cancelled' && (
        <CreditNoteSettlement
          creditNoteId={doc.id}
          issued={!!doc.number}
          total={settlement.total}
          currency={doc.currency ?? 'EUR'}
          invoice={settlement.invoice}
          applied={settlement.applied}
          refunds={settlement.refunds}
        />
      )}
      <DocumentHistory documentId={doc.id} currency={doc.currency ?? 'EUR'} />
    </div>
  )
}
