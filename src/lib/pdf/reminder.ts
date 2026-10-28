import { createElement, type ComponentProps } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import ReminderDocument from '@/components/pdf/ReminderDocument'
import { calcTotals } from '@/lib/utils/document'
import { generateEpcQr } from '@/lib/utils/epc-qr'
import { reminderFigures, type ReminderFigures } from '@/lib/utils/reminder-templates'
import { templateLang } from '@/lib/templates'
import type { DocumentTotals, Settings } from '@/types'
import type { PdfDocument } from './render'

// Server-only, like render.ts: import from route handlers, never from a client component.

type PdfElement = Parameters<typeof renderToBuffer>[0]

export type ReminderPdf = { buffer: Buffer; filename: string; figures: ReminderFigures; totals: DocumentTotals }

export function invoiceTotals(doc: PdfDocument): DocumentTotals {
  const discount = doc.discount_type && doc.discount_value ? { type: doc.discount_type, value: doc.discount_value } : null
  return calcTotals(doc.document_items ?? [], doc.payments ?? [], discount, doc.tax_treatment)
}

// "Zahlungserinnerung_RE-2026-0042.pdf", "1-Mahnung_RE-2026-0042.pdf"
export function reminderFilename(title: string, number: string): string {
  const slug = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '')
  return `${slug}_${number.replace(/["\\/\r\n]+/g, '_')}.pdf`
}

// The Mahnung for an issued invoice at `level`, dated today: open balance, fee and interest from
// the settings, the new deadline and an EPC QR code for the full amount due. Never stored: it is
// rendered for each email or download from the current payments.
export async function renderReminderPdf(
  doc: PdfDocument,
  settings: Settings,
  level: number,
  totals: DocumentTotals = invoiceTotals(doc),
): Promise<ReminderPdf> {
  if (!doc.number) throw new Error('Only issued invoices can be reminded')
  if (!doc.clients) throw new Error('Document has no client')
  const lang = templateLang(doc.language)
  const figures = reminderFigures({ dueDate: doc.due_date, balance: totals.balance_due, issuer: settings, level, lang })
  const currency = doc.currency ?? 'EUR'

  const qrCodeDataUri = settings.iban && figures.totalDue > 0
    ? await generateEpcQr({
        iban: settings.iban,
        bic: settings.bic ?? '',
        name: settings.company_name || settings.owner_name,
        amountEur: currency === 'EUR' ? figures.totalDue : undefined,
        reference: doc.number,
      })
    : null

  const props: ComponentProps<typeof ReminderDocument> = {
    settings,
    client: doc.clients,
    invoice: { number: doc.number, date: doc.date, due_date: doc.due_date, currency, language: lang },
    totals: { total: totals.total, total_paid: totals.total_paid },
    figures,
    qrCodeDataUri,
  }
  const buffer = await renderToBuffer(createElement(ReminderDocument, props) as unknown as PdfElement)
  return { buffer, filename: reminderFilename(figures.title, doc.number), figures, totals }
}
