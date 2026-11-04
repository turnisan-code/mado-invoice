import path from 'node:path'
import { createElement, type ComponentProps } from 'react'
import { NextRequest, NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { isUuid, requireUser } from '@/lib/auth'
import { loadSettings } from '@/lib/pdf/render'
import { preparePdfFonts, registerPdfFonts } from '@/components/pdf/fonts'
import StatementDocument from '@/components/pdf/StatementDocument'
import { loadClientStatement } from '@/lib/services/reports'
import { documentLanguage } from '@/lib/document-labels'
import { dispositionFilename } from '@/lib/utils/reminder'
import { makeT } from '@/lib/i18n'
import { getT } from '@/lib/i18n/server'
import { today } from '@/lib/utils/document'

export const maxDuration = 60

type PdfElement = Parameters<typeof renderToBuffer>[0]

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
    const [statement, settings] = await Promise.all([
      loadClientStatement(supabase, id, { from, to, openOnly }),
      loadSettings(supabase),
    ])
    if (!statement) return textResponse(t('errors.notFound'), 404)
    const { client, rows, sums } = statement

    const language = documentLanguage(client.language)
    const props: ComponentProps<typeof StatementDocument> = {
      settings, client, language, from, to, issuedOn, openOnly, rows, sums,
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
