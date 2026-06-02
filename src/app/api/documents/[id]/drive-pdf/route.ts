import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { calcTotals } from '@/lib/utils/document'
import { generateEpcQr } from '@/lib/utils/epc-qr'
import { renderToBuffer } from '@react-pdf/renderer'
import { google } from 'googleapis'
import { getOAuthClient } from '@/lib/google/client'
import InvoiceDocument from '@/components/pdf/InvoiceDocument'
import type { Settings, Client, DocumentItem, Payment, DocumentType, Language, Currency, TaxTreatment } from '@/types'
import React from 'react'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [{ data: doc }, { data: settings }] = await Promise.all([
    supabase.from('documents').select('*, document_items(*), payments(*), clients(*)').eq('id', id).single(),
    supabase.from('settings').select('*').single(),
  ])

  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 })
  if (!settings.drive_folder_id) return NextResponse.json({ error: 'No Drive folder configured' }, { status: 400 })
  if (!settings.gmail_refresh_token) return NextResponse.json({ error: 'Google not connected' }, { status: 400 })

  const client = doc.clients as unknown as Client
  const items = (doc.document_items ?? []) as DocumentItem[]
  const payments = (doc.payments ?? []) as Payment[]
  const discount = doc.discount_type && doc.discount_value
    ? { type: doc.discount_type as 'percent' | 'fixed', value: doc.discount_value }
    : null
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
    } catch { /* best-effort */ }
  }

  const taxNote = doc.tax_treatment === 'eu_reverse_charge'
    ? (lang === 'de' ? 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)' : 'Reverse charge — VAT to be accounted for by the recipient')
    : doc.tax_treatment === 'non_eu'
    ? (lang === 'de' ? 'Nicht steuerbar (Leistungsort außerhalb der EU)' : 'Not taxable — place of supply outside the EU')
    : null

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

  const oauth2 = getOAuthClient()
  oauth2.setCredentials({
    access_token: settings.gmail_access_token,
    refresh_token: settings.gmail_refresh_token,
    expiry_date: settings.gmail_token_expiry,
  })
  oauth2.on('tokens', async (tokens) => {
    await supabase.from('settings').update({
      gmail_access_token: tokens.access_token,
      ...(tokens.refresh_token ? { gmail_refresh_token: tokens.refresh_token } : {}),
      gmail_token_expiry: tokens.expiry_date,
    }).eq('id', settings.id)
  })

  const drive = google.drive({ version: 'v3', auth: oauth2 })
  const { Readable } = await import('stream')
  const stream = Readable.from(buffer)

  const { data: file } = await drive.files.create({
    requestBody: { name: filename, parents: [settings.drive_folder_id] },
    media: { mimeType: 'application/pdf', body: stream },
    fields: 'id,webViewLink',
  })

  return NextResponse.json({ fileId: file.id, webViewLink: file.webViewLink })
}
