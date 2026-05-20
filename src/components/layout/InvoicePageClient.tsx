'use client'

import { useRef } from 'react'
import DocumentBuilder, { type DocumentBuilderHandle } from '@/components/forms/DocumentBuilder'
import PaymentPanel from '@/components/layout/PaymentPanel'
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
}

export default function InvoicePageClient({
  type, settings, clients, catalogue, document, total, payments, currency,
  bookamatConfigured, bookamatBookingId,
}: Props) {
  const builderRef = useRef<DocumentBuilderHandle>(null)

  async function generatePdfBase64(): Promise<{ base64: string; filename: string } | null> {
    if (!builderRef.current) return null
    const result = await builderRef.current.buildPdfBlob(document.number ?? undefined)
    if (!result) return null
    const base64 = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(result.blob)
    })
    return { base64, filename: `${result.number}.pdf` }
  }

  return (
    <>
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6">
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
    </>
  )
}
