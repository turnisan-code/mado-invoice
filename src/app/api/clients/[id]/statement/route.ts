import path from 'node:path'
import { createElement, type ComponentProps } from 'react'
import { NextRequest, NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { isUuid, requireUser } from '@/lib/auth'
import type { createClient } from '@/lib/supabase/server'
import { loadSettings } from '@/lib/pdf/render'
import { preparePdfFonts, registerPdfFonts } from '@/components/pdf/fonts'
import StatementDocument from '@/components/pdf/StatementDocument'
import { selectStatementRows, statementRows, statementSums, type StatementDoc } from '@/lib/statement'
import { documentLanguage } from '@/lib/document-labels'
import { dispositionFilename } from '@/lib/utils/reminder'
import { makeT } from '@/lib/i18n'
import { getT } from '@/lib/i18n/server'
import { today } from '@/lib/utils/document'
import type { Client } from '@/types'

export const maxDuration = 60

type PdfElement = Parameters<typeof renderToBuffer>[0]
type ServerClient = Awaited<ReturnType<typeof createClient>>

const DOC_COLUMNS = 'id, type, number, date, due_date, status, currency, tax_treatment, discount_type, discount_value, cancels_document_id, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount, kind, credit_note_id)'

// .in() lists travel in the URL, so long id lists are fetched in slices.
const SLICE = 100

async function inSlices<T>(ids: string[], fetch: (slice: string[]) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += SLICE) {
    const { data, error } = await fetch(ids.slice(i, i + SLICE))
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as T[]))
  }
  return out
}

// The Storno of every cancelled invoice and the invoice of every Storno that the statement's
// documents do not hold already (a Storno dated after `to`), so each pair nets out.
async function loadCounterparts(supabase: ServerClient, docs: StatementDoc[]): Promise<StatementDoc[]> {
  const ids = new Set(docs.map(d => d.id))
  const cancelledWithoutStorno = docs
    .filter(d => d.type === 'invoice' && d.status === 'cancelled' && !docs.some(c => c.cancels_document_id === d.id))
    .map(d => d.id)
  const missingInvoices = [...new Set(docs.map(d => d.cancels_document_id).filter((v): v is string => !!v && !ids.has(v)))]
  const [stornos, invoices] = await Promise.all([
    inSlices<StatementDoc>(cancelledWithoutStorno, slice => supabase
      .from('documents').select(DOC_COLUMNS).eq('type', 'credit_note').not('number', 'is', null).in('cancels_document_id', slice)),
    inSlices<StatementDoc>(missingInvoices, slice => supabase
      .from('documents').select(DOC_COLUMNS).eq('type', 'invoice').not('number', 'is', null).in('id', slice)),
  ])
  return [...stornos, ...invoices].filter(d => !ids.has(d.id))
}

function textResponse(message: string, status: number) {
  return new NextResponse(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } })
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const validDate = (value: string | null): value is string => !!value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))

// The client's statement of account (Kontoauszug) as a PDF in the client's language: every issued
// invoice and credit note dated ?from=…&to=… (default: this year up to today), plus older ones
// still open, with what has been paid, credited and is still open as of today; ?open=1 lists every
// document up to ?to with an open amount. The dialog opens this in a new tab, so errors are short
// texts in the UI language.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { t } = await getT()
  const { id } = await params
  if (!isUuid(id)) return textResponse(t('errors.notFound'), 404)

  const issuedOn = today()
  const search = req.nextUrl.searchParams
  const openOnly = search.get('open') === '1'
  const to = search.get('to') || issuedOn
  // Open items ignore the start of the period.
  const from = search.get('from') || `${to.slice(0, 4)}-01-01`
  if (!validDate(to) || (!openOnly && (!validDate(from) || from > to))) return textResponse(t('projects.statement.rangeInvalid'), 400)

  try {
    // Everything up to `to`: older documents still open belong on the statement too.
    const [{ data: client, error: clientErr }, { data: docs, error: docsErr }, settings] = await Promise.all([
      supabase.from('clients').select('*').eq('id', id).maybeSingle(),
      supabase
        .from('documents')
        .select(DOC_COLUMNS)
        .eq('client_id', id)
        .in('type', ['invoice', 'credit_note'])
        .not('number', 'is', null)
        .lte('date', to)
        .order('date'),
      loadSettings(supabase),
    ])
    if (clientErr || docsErr) throw new Error((clientErr ?? docsErr)!.message)
    if (!client) return textResponse(t('errors.notFound'), 404)

    const loaded = (docs ?? []) as unknown as StatementDoc[]
    const documents = [...loaded, ...await loadCounterparts(supabase, loaded)]
    // Applied credit notes are 'credit' rows on the invoice they correct, not on the credit note.
    const applied = new Map<string, number>()
    const credits = await inSlices<{ amount: number; credit_note_id: string }>(
      documents.filter(d => d.type === 'credit_note').map(d => d.id),
      slice => supabase.from('payments').select('amount, credit_note_id').eq('kind', 'credit').in('credit_note_id', slice),
    )
    for (const p of credits) applied.set(p.credit_note_id, (applied.get(p.credit_note_id) ?? 0) + Number(p.amount))

    const rows = selectStatementRows(statementRows(documents, applied), { from, to, openOnly })
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
    return textResponse(t('projects.statement.failed'), 500)
  }
}
