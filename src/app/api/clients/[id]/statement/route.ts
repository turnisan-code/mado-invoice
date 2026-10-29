import path from 'node:path'
import { createElement, type ComponentProps } from 'react'
import { NextRequest, NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { isUuid, requireUser } from '@/lib/auth'
import { loadSettings } from '@/lib/pdf/render'
import { preparePdfFonts, registerPdfFonts } from '@/components/pdf/fonts'
import StatementDocument from '@/components/pdf/StatementDocument'
import { hasOpenAmount, statementRows, statementSums, type StatementDoc } from '@/lib/statement'
import { documentLanguage } from '@/lib/document-labels'
import { dispositionFilename } from '@/lib/utils/reminder'
import { makeT } from '@/lib/i18n'
import { today } from '@/lib/utils/document'
import type { Client } from '@/types'

export const maxDuration = 60

type PdfElement = Parameters<typeof renderToBuffer>[0]

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const validDate = (value: string | null): value is string => !!value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))

const DOC_COLUMNS = 'id, type, number, date, due_date, status, currency, tax_treatment, discount_type, discount_value, cancels_document_id, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount, kind)'

// The client's statement of account (Kontoauszug) as a PDF in the client's language: every issued
// invoice and credit note dated ?from=…&to=… (default: this year up to today) with what has been
// paid, credited and is still open as of today; ?open=1 keeps only documents with an open amount.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  const issuedOn = today()
  const search = req.nextUrl.searchParams
  const from = search.get('from') || `${issuedOn.slice(0, 4)}-01-01`
  const to = search.get('to') || issuedOn
  if (!validDate(from) || !validDate(to) || from > to) {
    return NextResponse.json({ error: 'Invalid period', code: 'bad_period' }, { status: 400 })
  }
  const openOnly = search.get('open') === '1'

  try {
    const [{ data: client, error: clientErr }, { data: docs, error: docsErr }, settings] = await Promise.all([
      supabase.from('clients').select('*').eq('id', id).maybeSingle(),
      supabase
        .from('documents')
        .select(DOC_COLUMNS)
        .eq('client_id', id)
        .in('type', ['invoice', 'credit_note'])
        .not('number', 'is', null)
        .gte('date', from)
        .lte('date', to)
        .order('date'),
      loadSettings(supabase),
    ])
    if (clientErr || docsErr) throw new Error((clientErr ?? docsErr)!.message)
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

    const documents = (docs ?? []) as unknown as StatementDoc[]
    // Applied credit notes are 'credit' rows on the invoice they correct, not on the credit note.
    const creditNoteIds = documents.filter(d => d.type === 'credit_note').map(d => d.id)
    const applied = new Map<string, number>()
    for (let i = 0; i < creditNoteIds.length; i += 100) {
      const { data, error } = await supabase
        .from('payments')
        .select('amount, credit_note_id')
        .eq('kind', 'credit')
        .in('credit_note_id', creditNoteIds.slice(i, i + 100))
      if (error) throw new Error(error.message)
      for (const p of data ?? []) applied.set(p.credit_note_id as string, (applied.get(p.credit_note_id as string) ?? 0) + Number(p.amount))
    }

    const all = statementRows(documents, applied)
    const rows = openOnly ? all.filter(hasOpenAmount) : all
    const language = documentLanguage(client.language)
    const props: ComponentProps<typeof StatementDocument> = {
      settings, client: client as Client, language, from, to, issuedOn, openOnly, rows, sums: statementSums(rows),
    }

    registerPdfFonts(path.join(process.cwd(), 'public', 'fonts'))
    await preparePdfFonts()
    const buffer = await renderToBuffer(createElement(StatementDocument, props) as unknown as PdfElement)
    const name = [makeT(language)('projects.statement.pdf.filename'), client.client_number, issuedOn].filter(Boolean).join('_')
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; ${dispositionFilename(`${name.replace(/["\\/\r\n]+/g, '_')}.pdf`)}`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    console.error('[clients/statement]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'PDF unavailable', code: 'pdf_failed' }, { status: 500 })
  }
}
