import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { safeNextPath } from '@/app/auth/safe-next'
import { pendingTotpFactor } from '@/app/auth/mfa'

const PUBLIC_PATHS = ['/login', '/favicon.ico', '/manifest.webmanifest']
// /auth/callback turns the emailed recovery link into a session, so it runs before anyone is signed in.
const PUBLIC_PREFIXES = ['/portal/', '/api/portal/', '/api/cron/', '/api/gmail/callback', '/auth/', '/_next/', '/icon', '/apple-icon']

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.includes(pathname) || PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix))
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    },
  )

  const { data: { user } } = await supabase.auth.getUser()
  // With a verified authenticator, a password-only (aal1) session is not signed in yet.
  const mfaPending = user ? (await pendingTotpFactor(supabase.auth, user)) !== null : false
  const signedIn = !!user && !mfaPending
  const { pathname, search, searchParams } = request.nextUrl

  // Refreshed session cookies must travel with every redirect, or the browser keeps the stale ones.
  const withCookies = (res: NextResponse) => {
    response.cookies.getAll().forEach(cookie => res.cookies.set(cookie))
    return res
  }

  if (pathname === '/login') {
    if (!signedIn) return response
    return withCookies(NextResponse.redirect(new URL(safeNextPath(searchParams.get('next')), request.url)))
  }

  if (signedIn || isPublicPath(pathname)) return response

  if (pathname.startsWith('/api/')) return withCookies(NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 }))
  const login = new URL('/login', request.url)
  if (mfaPending) login.searchParams.set('mfa', '1')
  if (pathname !== '/') login.searchParams.set('next', `${pathname}${search}`)
  return withCookies(NextResponse.redirect(login))
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?|ttf)$).*)'],
}
