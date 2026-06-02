'use client'

import { useRef } from 'react'
import DocumentBuilder, { type DocumentBuilderHandle } from '@/components/forms/DocumentBuilder'
import PaymentPanel from '@/components/layout/PaymentPanel'
import ReminderButton from '@/components/layout/ReminderButton'
import type { Settings, Client, CatalogueItem, Document, Currency } from '@/types'

interface Payment {
  id: string
  date: string
  amount: number
  note: string | null
}

interface Props {
  type: 'invoice'
  settings: Settings
  clients: Client[]
  catalogue: CatalogueItem[]
  document: Document & { items: Document['items']; payments: Payment[] }
  total: number
  payments: Payment[]
  currency: Currency
  bookamatConfigured: boolean
  bookamatBookingId: string | null
  reminderSentAt: string | null
}

export default function InvoicePageClient({
  type, settings, clients, catalogue, document, total, payments, currency,
  bookamatConfigured, bookamatBookingId, reminderSentAt,
}: Props) {
  const builderRef = useRef<DocumentBuilderHandle>(null)

  async function generatePdfBase64(): Promise<{ base64: string; filename: string } | null> {
    if (!builderRef.current) return null
    const result = await builderRef.current.buildPdfBlob(document.number ?? undefined)
    if (!result) return null
    const base64 = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve((reader.result as string).split(',')[1])
      reader.readAsDataURL(result.blob)
    })
    return { base64, filename: `${result.number}.pdf` }
  }

  const gmailConfigured = !!(settings.gmail_refresh_token)
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
        total={total}
        payments={payments}
        currency={currency}
        bookamatConfigured={bookamatConfigured}
        bookamatBookingId={bookamatBookingId}
        generatePdfForBookamat={generatePdfBase64}
      />
      {showReminder && (
        <ReminderButton
          documentId={document.id}
          reminderSentAt={reminderSentAt}
          gmailConfigured={gmailConfigured}
          generatePdf={generatePdfBase64}
        />
      )}
    </>
  )
}
