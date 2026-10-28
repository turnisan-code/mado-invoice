import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { safeNextPath } from '../safe-next'

// Landing point of Supabase email links (password recovery). The default email template sends a
// PKCE ?code=, which only works in the browser that requested the link (its code verifier is a
// cookie there). A template that links here with ?token_hash=…&type=recovery works on any device.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null

  const supabase = await createClient()
  let ok = false
  if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error
  } else if (tokenHash && type) {
    ok = !(await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error
  }

  if (!ok) return NextResponse.redirect(new URL('/login?error=link', origin))
  return NextResponse.redirect(new URL(safeNextPath(searchParams.get('next')), origin))
}
