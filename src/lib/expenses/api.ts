// The expense routes' error answers (PR 9a). What they accept: lib/expenses/input.ts.
import { NextResponse } from 'next/server'
import { BookamatError } from '@/lib/bookamat'

// A BookamatError (or any error) as the routes answer it: what the owner can fix is a 400,
// a booking whose fate is open a 409, Bookamat failing a 502, the database a 500
export function expenseError(err: unknown): NextResponse {
  if (err instanceof BookamatError) {
    const status = err.code === 'database' || err.code === 'db_write' ? 500
      : err.code === 'forget_not_found' || err.code === 'not_found' ? 404
      : err.code === 'in_progress' || err.code === 'unknown_outcome' || err.code === 'forget_still_booked' || err.code === 'unconfirmed' ? 409
      : err.code === 'preview' ? 403
      : err.code === 'timeout' || err.code === 'network' || (err.code === 'bookamat' && err.status >= 500) ? 502
      : 400
    return NextResponse.json({ error: err.message, code: err.code, details: err.detail }, { status })
  }
  console.error('[expenses]', err)
  return NextResponse.json({ error: err instanceof Error ? err.message : String(err), code: 'server_error' }, { status: 500 })
}
