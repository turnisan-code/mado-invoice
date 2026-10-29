import { NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import type { ApiErrorCode, LifecycleErrorCode } from '@/types'

type ServerClient = Awaited<ReturnType<typeof createClient>>

export type AuthResult =
  | { ok: true; supabase: ServerClient; user: User }
  | { ok: false; response: NextResponse }

// Every error answer: `code` is what the browser words (src/lib/api-errors.ts), `error` is English
// for logs and is never shown.
export function apiError(status: number, code: ApiErrorCode | LifecycleErrorCode, error: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error, code, ...extra }, { status })
}

const LIFECYCLE_CODE = /^MI0\d\d$/

// A failed query or RPC: lifecycle refusals keep their code and detail (the browser words them),
// anything else is 'database'.
export function databaseError(error: { message: string; code?: string | null; details?: string | null }, status = 500): NextResponse {
  if (error.code && LIFECYCLE_CODE.test(error.code)) {
    return apiError(status, error.code as LifecycleErrorCode, error.message, error.details ? { details: error.details } : undefined)
  }
  console.error('[api] database error:', error.code, error.message)
  return apiError(status, 'database', error.message)
}

// First call of every route handler that acts for the signed-in owner. RLS would hide the data
// anyway, but without this an anonymous call gets a misleading "not found" or a silent no-op.
export async function requireUser(): Promise<AuthResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, response: apiError(401, 'unauthorized', 'Unauthorized') }
  return { ok: true, supabase, user }
}

// Request bodies are untrusted: a malformed one is a 400, never a crash.
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

export const invalidJson = () => apiError(400, 'invalid_json', 'Invalid JSON')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}
