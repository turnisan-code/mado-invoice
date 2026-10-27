import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'

// Vercel calls cron routes with "Authorization: Bearer <CRON_SECRET>". Returns the response
// to send when the call is not allowed, null when it is.
export function authorizeCron(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })

  const expected = Buffer.from(`Bearer ${secret}`)
  const provided = Buffer.from(req.headers.get('authorization') ?? '')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
