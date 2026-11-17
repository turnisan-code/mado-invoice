import { NextRequest, NextResponse } from 'next/server'
import { apiError, databaseError, invalidJson, readJsonObject, requireUser } from '@/lib/auth'
import { parseRule } from '@/lib/expenses/input'

// The Buchungsregeln, in their one order (by name, then id)
export async function GET() {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { data, error } = await auth.supabase.from('booking_rules').select('*').order('name').order('id')
  if (error) return databaseError(error)
  return NextResponse.json(data ?? [])
}

export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  const rule = parseRule(body)
  if (!rule) return apiError(400, 'invalid_request', 'Invalid Buchungsregel')
  const { data, error } = await auth.supabase.from('booking_rules').insert(rule).select('*').single()
  if (error) return databaseError(error)
  return NextResponse.json(data, { status: 201 })
}
