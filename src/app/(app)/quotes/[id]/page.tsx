import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import DocumentBuilder from '@/components/forms/DocumentBuilder'
import DocumentStatusBar from '@/components/layout/DocumentStatusBar'
import ConvertDocumentButton from '@/components/layout/ConvertDocumentButton'
import ShareLinkButton from '@/components/layout/ShareLinkButton'
import IssuedPdfLink from '@/components/layout/IssuedPdfLink'
import DocumentHistory from '@/components/layout/DocumentHistory'
import DuplicateDocumentButton from '@/components/layout/DuplicateDocumentButton'
import DeleteDocumentButton from '@/components/layout/DeleteDocumentButton'
import { toPublicSettings } from '@/lib/public-settings'
import SettingsMissing from '@/components/layout/SettingsMissing'
import { formatDate } from '@/lib/utils/document'
import { buttonVariants } from '@/components/ui/button'
import Link from 'next/link'
import { ArrowLeft, FileText } from 'lucide-react'
import { getT } from '@/lib/i18n/server'
import MarkResponsesRead from './MarkResponsesRead'

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { t, lang } = await getT()

  const [{ data: doc }, { data: settings }, { data: clients }, { data: catalogue }, { data: invoice }, { count: unreadResponses }] = await Promise.all([
    supabase.from('documents').select('*, document_items(*), payments(*)').eq('id', id).eq('type', 'quote').single(),
    supabase.from('settings').select('*').single(),
    supabase.from('clients').select('*').order('name'),
    supabase.from('catalogue_items').select('*').eq('active', true).order('sort_order'),
    // Once converted, the quote links to its invoice instead of offering a second conversion.
    supabase.from('documents').select('id, number').eq('converted_from_id', id).eq('type', 'invoice').order('created_at').limit(1).maybeSingle(),
    supabase.from('document_events').select('id', { count: 'exact', head: true }).eq('document_id', id).eq('type', 'portal_responded').is('read_at', null),
  ])

  if (!doc) notFound()
  if (!settings) return <SettingsMissing />

  const publicSettings = toPublicSettings(settings)
  const docWithItems = { ...doc, items: doc.document_items ?? [], payments: doc.payments ?? [] }

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/quotes" aria-label={t('documents.backToQuotes')} className="h-11 w-11 -m-3.5 inline-flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors shrink-0">
            <ArrowLeft size={16} />
          </Link>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold truncate">{doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">{t('common.draft')}</span>}</h1>
            {doc.issued_at && <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('documents.issued', { date: formatDate(doc.issued_at, lang) })}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2 pl-7 sm:pl-0">
          <DocumentStatusBar document={doc} />
          {doc.pdf_path && <IssuedPdfLink documentId={doc.id} driveFileId={doc.drive_file_id} />}
          <div className="flex-1 sm:hidden" />
          {doc.number && <ShareLinkButton documentId={doc.id} number={doc.number} kind="quote" language={doc.language} initialToken={doc.share_token ?? null} driveReady={publicSettings.drive_configured} />}
          {invoice ? (
            <Link href={`/invoices/${invoice.id}`} title={t('lifecycle.convert.openInvoiceTitle')} className={`${buttonVariants({ variant: 'outline', size: 'sm' })} flex items-center gap-1.5`}>
              <FileText size={14} />
              <span className="sr-only sm:not-sr-only">{invoice.number ? t('lifecycle.convert.openInvoice', { number: invoice.number }) : t('lifecycle.convert.openInvoiceDraft')}</span>
            </Link>
          ) : (doc.status === 'sent' || doc.status === 'accepted') && (
            <ConvertDocumentButton kind="invoice" sourceId={doc.id} />
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
      <DocumentHistory documentId={doc.id} currency={doc.currency ?? 'EUR'} />
      {!!unreadResponses && <MarkResponsesRead documentId={doc.id} />}
    </div>
  )
}
