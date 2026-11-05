import { NextResponse } from 'next/server'
import { isUuid, readJsonObject, requireUser } from '@/lib/auth'
import { INVOICE_GROUPINGS } from '@/lib/projects'
import { invoiceProjectEntries } from '@/lib/services/projects'
import type { InvoiceGrouping } from '@/types'

const MAX_ROWS = 500

const STATUS = { not_found: 404, nothing: 400, entries_changed: 409, failed: 500 } as const

function uuidList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ROWS || !value.every(isUuid)) return null
  return [...new Set(value)]
}

// "Invoice unbilled" (invoiceProjectEntries). Body: { timeEntryIds, expenseIds, grouping }.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Project not found', code: 'not_found' }, { status: 404 })

  const body = await readJsonObject(req)
  const timeEntryIds = uuidList(body?.timeEntryIds)
  const expenseIds = uuidList(body?.expenseIds)
  const grouping = body?.grouping ?? 'entry'
  if (!body || !timeEntryIds || !expenseIds || !INVOICE_GROUPINGS.includes(grouping as InvoiceGrouping)) {
    return NextResponse.json({ error: 'Invalid request', code: 'bad_request' }, { status: 400 })
  }

  const result = await invoiceProjectEntries(supabase, id, { timeEntryIds, expenseIds, grouping: grouping as InvoiceGrouping })
  if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: STATUS[result.code] })
  return NextResponse.json({ documentId: result.documentId })
}
