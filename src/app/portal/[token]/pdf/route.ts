import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { calcTotals, getTaxNote } from '@/lib/utils/document'
import { fetchReference } from '@/lib/utils/document-reference'
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

  if (!doc?.number) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const filename = `${doc.number}.pdf`
  const pdfHeaders = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
  }

  // The frozen copy stored at issuance is what the client received; re-rendering is only a fallback.
  if (doc.pdf_path) {
    const { data: stored } = await supabase.storage.from('documents').download(doc.pdf_path)
    if (stored) return new NextResponse(stored, { headers: pdfHeaders })
  }

  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 })

  const client = doc.clients as unknown as Client
  const items = (doc.document_items ?? []) as DocumentItem[]
  const payments = (doc.payments ?? []) as Payment[]
  const discount = doc.discount_type && doc.discount_value ? { type: doc.discount_type as 'percent' | 'fixed', value: doc.discount_value } : null
  const totals = calcTotals(items, payments, discount, doc.tax_treatment)

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

  const taxNote = getTaxNote(doc.tax_treatment ?? 'at_vat', lang, settings as Settings)
  const reference = await fetchReference(supabase, doc)

  const docData = {
    number: doc.number ?? '',
    date: doc.date,
    service_date: doc.service_date,
    service_date_end: doc.service_date_end ?? null,
    due_date: doc.due_date,
    type: doc.type as DocumentType,
    language: lang,
    currency: (doc.currency ?? 'EUR') as Currency,
    tax_treatment: (doc.tax_treatment ?? 'at_vat') as TaxTreatment,
    notes: doc.notes,
    tax_note: taxNote,
    discount_type: doc.discount_type as 'percent' | 'fixed' | null,
    discount_value: doc.discount_value,
    skonto_percent: doc.skonto_percent ?? null,
    skonto_days: doc.skonto_days ?? null,
    items,
    totals,
    reference,
  }

  const buffer = await renderToBuffer(React.createElement(InvoiceDocument, {
    settings: settings as Settings,
    client,
    document: docData,
    qrCodeDataUri,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)

  return new NextResponse(new Uint8Array(buffer), { headers: pdfHeaders })
}
