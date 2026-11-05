import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import DocumentStatusBar from '@/components/layout/DocumentStatusBar'
import DeleteDocumentButton from '@/components/layout/DeleteDocumentButton'
import DuplicateDocumentButton from '@/components/layout/DuplicateDocumentButton'
import InvoicePageClient from '@/components/layout/InvoicePageClient'
import ShareLinkButton from '@/components/layout/ShareLinkButton'
import IssuedPdfLink from '@/components/layout/IssuedPdfLink'
import DocumentHistory from '@/components/layout/DocumentHistory'
import ConvertDocumentButton from '@/components/layout/ConvertDocumentButton'
import MakeRecurringDialog from '@/components/recurring/MakeRecurringDialog'
import { calcTotals, formatDate, orderItems } from '@/lib/utils/document'
import { toPublicSettings } from '@/lib/public-settings'
import SettingsMissing from '@/components/layout/SettingsMissing'
import Link from 'next/link'
import { ArrowLeft, Info, Repeat } from 'lucide-react'
import { getT } from '@/lib/i18n/server'
import type { DictKey } from '@/lib/i18n'
import type { RecurringSchedule } from '@/types'

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { t, lang } = await getT()

  const [{ data: doc }, { data: settings }, { data: clients }, { data: catalogue }, { data: reminderLog }, { data: scheduleRow }] = await Promise.all([
    supabase.from('documents').select('*, document_items(*), payments(*)').eq('id', id).eq('type', 'invoice').single(),
    supabase.from('settings').select('*').single(),
    supabase.from('clients').select('*').order('name'),
    supabase.from('catalogue_items').select('*').eq('active', true).order('sort_order'),
    supabase.from('reminder_log').select('*').eq('document_id', id).order('sent_at', { ascending: false }),
    supabase.from('recurring_schedules').select('*').eq('source_document_id', id).maybeSingle(),
  ])

  if (!doc) notFound()
  if (!settings) return <SettingsMissing />

  // An issued final invoice that deducts this one keeps that deduction: no credit note here
  // (create_credit_note refuses it, MI020) until the final invoice is cancelled.
  const { data: finalInvoice } = doc.final_invoice_id
    ? await supabase.from('documents').select('id, number, status').eq('id', doc.final_invoice_id).maybeSingle()
    : { data: null }
  const deductedOn = finalInvoice?.number && finalInvoice.status !== 'cancelled'
    ? { id: finalInvoice.id as string, number: finalInvoice.number as string }
    : null

  const schedule = (scheduleRow ?? null) as RecurringSchedule | null
  const publicSettings = toPublicSettings(settings)
  const payments = doc.payments ?? []
  const docWithItems = { ...doc, items: doc.document_items ?? [], payments }
  const totals = calcTotals(
    doc.document_items ?? [],
    payments,
    doc.discount_type && doc.discount_value ? { type: doc.discount_type as 'percent' | 'fixed', value: doc.discount_value } : null,
    doc.tax_treatment,
  )

  const client = (clients ?? []).find(c => c.id === doc.client_id)
  const firstItem = orderItems<{ line_type?: string | null; description?: string | null }>(doc.document_items ?? []).find(i => (i.line_type ?? 'item') === 'item')
  const recurringName = [client?.company || client?.name, firstItem?.description].filter(Boolean).join(' – ').slice(0, 60)

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/invoices" aria-label={t('documents.backToInvoices')} className="h-11 w-11 -m-3.5 inline-flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors shrink-0">
            <ArrowLeft size={16} />
          </Link>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold truncate">{doc.number ?? <span className="text-neutral-500 dark:text-neutral-500">{t('common.draft')}</span>}</h1>
            {doc.issued_at && <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('documents.issued', { date: formatDate(doc.issued_at, lang) })}</p>}
            {schedule && (
              <Link href="/recurring" className="inline-flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors">
                <Repeat size={12} />
                {schedule.active
                  ? t('recurring.templateBanner', { interval: t(`recurring.intervals.${schedule.interval}` as DictKey), date: formatDate(schedule.next_date, lang) })
                  : t('recurring.templateBannerInactive', { interval: t(`recurring.intervals.${schedule.interval}` as DictKey), status: t(schedule.end_date && schedule.next_date > schedule.end_date ? 'recurring.statuses.ended' : 'recurring.statuses.paused') })}
              </Link>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 pl-7 sm:pl-0">
          <DocumentStatusBar document={doc} />
          {doc.pdf_path && <IssuedPdfLink documentId={doc.id} driveFileId={doc.drive_file_id} />}
          <div className="flex-1 sm:hidden" />
          {doc.number && <ShareLinkButton documentId={doc.id} number={doc.number} kind="invoice" invoiceKind={doc.invoice_kind} language={doc.language} initialToken={doc.share_token ?? null} driveReady={publicSettings.drive_configured} />}
          {doc.number && doc.status !== 'cancelled' && !deductedOn && <ConvertDocumentButton kind="credit_note" sourceId={doc.id} />}
          {doc.status !== 'cancelled' && !schedule && <MakeRecurringDialog invoiceId={doc.id} defaultName={recurringName} />}
          <DuplicateDocumentButton docId={doc.id} docType="invoice" backTo="/invoices" />
          <DeleteDocumentButton id={doc.id} backTo="/invoices" docNumber={doc.number} docType="invoice" isTemplate={!!schedule} />
        </div>
      </div>
      {doc.number && doc.status !== 'cancelled' && deductedOn && (
        <p className="flex items-start gap-2 text-sm text-neutral-500 dark:text-neutral-400">
          <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {t('deposits.errors.deducted')}{' '}
            <Link href={`/invoices/${deductedOn.id}`} className="underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-200">
              {t('deposits.quote.openFinal', { number: deductedOn.number })}
            </Link>
          </span>
        </p>
      )}
      <InvoicePageClient
        type="invoice"
        settings={publicSettings}
        clients={clients ?? []}
        catalogue={catalogue ?? []}
        document={docWithItems}
        total={totals.total}
        payments={payments}
        currency={doc.currency ?? 'EUR'}
        bookamatConfigured={publicSettings.bookamat_configured}
        bookamatBookingId={doc.bookamat_booking_id ?? null}
        reminderSentAt={doc.reminder_sent_at ?? null}
        reminderLevel={doc.reminder_level ?? 0}
        reminderLog={reminderLog ?? []}
      />
      <DocumentHistory documentId={doc.id} currency={doc.currency ?? 'EUR'} />
    </div>
  )
}
