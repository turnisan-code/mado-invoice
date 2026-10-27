'use client'

import { useRef } from 'react'
import DocumentBuilder, { type DocumentBuilderHandle } from '@/components/forms/DocumentBuilder'
import PaymentPanel from '@/components/layout/PaymentPanel'
import ReminderButton from '@/components/layout/ReminderButton'
import { formatDate } from '@/lib/utils/document'
import { reminderTitle } from '@/lib/utils/reminder-templates'
import type { Client, CatalogueItem, Document, Currency, Payment, ReminderLogEntry } from '@/types'
import type { PublicSettings } from '@/lib/public-settings'
import { useT } from '@/lib/i18n/client'

interface Props {
  type: 'invoice'
  settings: PublicSettings
  clients: Client[]
  catalogue: CatalogueItem[]
  document: Document & { items: Document['items']; payments: Payment[] }
  total: number
  payments: Payment[]
  currency: Currency
  bookamatConfigured: boolean
  bookamatBookingId: string | null
  reminderSentAt: string | null
  reminderLevel: number
  reminderLog: ReminderLogEntry[]
}

export default function InvoicePageClient({
  type, settings, clients, catalogue, document, total, payments, currency,
  bookamatConfigured, bookamatBookingId, reminderSentAt, reminderLevel, reminderLog,
}: Props) {
  const builderRef = useRef<DocumentBuilderHandle>(null)
  const { t, lang } = useT()

  async function generatePdfBase64(): Promise<{ base64: string; filename: string } | null> {
    if (!builderRef.current) return null
    const result = await builderRef.current.buildPdfBlob(document.number ?? undefined, true)
    if (!result) return null
    const base64 = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve((reader.result as string).split(',')[1])
      reader.readAsDataURL(result.blob)
    })
    return { base64, filename: `${result.number}.pdf` }
  }

  const gmailConfigured = settings.gmail_connected
  const showReminder = (document.status === 'overdue' || document.status === 'sent') && gmailConfigured

  return (
    <>
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6">
        <DocumentBuilder
          ref={builderRef}
          type={type}
          settings={settings}
          clients={clients}
          catalogue={catalogue}
          document={document}
        />
      </div>
      <PaymentPanel
        documentId={document.id}
        number={document.number ?? null}
        status={document.status}
        date={document.date}
        total={total}
        payments={payments}
        currency={currency}
        skontoPercent={document.skonto_percent ?? null}
        skontoDays={document.skonto_days ?? null}
        bookamatConfigured={bookamatConfigured}
        bookamatBookingId={bookamatBookingId}
        generatePdfForBookamat={generatePdfBase64}
      />
      {(showReminder || reminderLog.length > 0) && (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">{t('reminders.title')}</h2>
            {showReminder && (
              <ReminderButton
                documentId={document.id}
                reminderSentAt={reminderSentAt}
                reminderLevel={reminderLevel}
                maxLevel={settings.reminder_max_level}
                gmailConfigured={gmailConfigured}
                generatePdf={generatePdfBase64}
              />
            )}
          </div>
          {reminderLog.length > 0 && (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
              {reminderLog.map(entry => (
                <div key={entry.id} className="flex items-center py-2 gap-3">
                  <span className="text-neutral-400 dark:text-neutral-500 w-24 shrink-0">{formatDate(entry.sent_at, lang)}</span>
                  <span className="font-medium">{reminderTitle(entry.level, lang)}</span>
                  {entry.to_email && <span className="text-neutral-400 dark:text-neutral-500 flex-1 truncate">{entry.to_email}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
