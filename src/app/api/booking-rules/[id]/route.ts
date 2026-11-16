import { NextRequest, NextResponse } from 'next/server'
import { apiError, databaseError, invalidJson, isUuid, readJsonObject, requireUser } from '@/lib/auth'
import { parseRule } from '@/lib/expenses/input'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Buchungsregel not found')
  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  const rule = parseRule(body)
  if (!rule) return apiError(400, 'invalid_request', 'Invalid Buchungsregel')
  const { data, error } = await auth.supabase.from('booking_rules').update({ ...rule, updated_at: new Date().toISOString() }).eq('id', id).select('*')
  if (error) return databaseError(error)
  if (!data?.length) return apiError(404, 'not_found', 'Buchungsregel not found')
  return NextResponse.json(data[0])
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Buchungsregel not found')
  const { data, error } = await auth.supabase.from('booking_rules').delete().eq('id', id).select('id')
  if (error) return databaseError(error)
  if (!data?.length) return apiError(404, 'not_found', 'Buchungsregel not found')
  return NextResponse.json({ ok: true })
}
