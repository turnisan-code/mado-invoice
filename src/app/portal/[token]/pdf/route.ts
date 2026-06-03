import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { calcTotals, getTaxNote } from '@/lib/utils/document'
import { generateEpcQr } from '@/lib/utils/epc-qr'
import { renderToBuffer } from '@react-pdf/renderer'
import InvoiceDocument from '@/components/pdf/InvoiceDocument'
import type { Settings, Client, DocumentItem, Payment, DocumentType, Language, Currency, TaxTreatment } from '@/types'
import React from 'react'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: doc } = await supabase
    .from('documents')
    .select('*, document_items(*), payments(*), clients(*)')
    .eq('share_token', token)
    .single()

  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 })

  const client = doc.clients as unknown as Client
  const items = (doc.document_items ?? []) as DocumentItem[]
  const payments = (doc.payments ?? []) as Payment[]
  const discount = doc.discount_type && doc.discount_value ? { type: doc.discount_type as 'percent' | 'fixed', value: doc.discount_value } : null
  const totals = calcTotals(items, payments, discount)

  const lang = (doc.language ?? 'de') as Language
  let qrCodeDataUri: string | null = null

  if (settings.iban && doc.type === 'invoice' && totals.balance_due > 0) {
    try {
      qrCodeDataUri = await generateEpcQr({
        iban: settings.iban,
        bic: settings.bic ?? '',
        name: settings.company_name,
        amountEur: doc.currency === 'EUR' ? totals.balance_due : undefined,
        reference: doc.number ?? '',
      })
    } catch {
      // QR generation is best-effort
    }
  }

  const taxNote = getTaxNote(doc.tax_treatment ?? 'at_vat', lang)

  const docData = {
    number: doc.number ?? '',
    date: doc.date,
    service_date: doc.service_date,
    due_date: doc.due_date,
    type: doc.type as DocumentType,
    language: lang,
    currency: (doc.currency ?? 'EUR') as Currency,
    tax_treatment: (doc.tax_treatment ?? 'at_vat') as TaxTreatment,
    notes: doc.notes,
    tax_note: taxNote,
    discount_type: doc.discount_type as 'percent' | 'fixed' | null,
    discount_value: doc.discount_value,
    items,
    totals,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buffer = await renderToBuffer(React.createElement(InvoiceDocument, {
    settings: settings as Settings,
    client,
    document: docData,
    qrCodeDataUri,
  }) as any)

  const filename = `${doc.number ?? 'document'}.pdf`

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
