import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const PUBLIC_PATHS = ['/login', '/favicon.ico', '/manifest.webmanifest']
const PUBLIC_PREFIXES = ['/portal/', '/api/portal/', '/api/cron/', '/api/gmail/callback', '/_next/', '/icon', '/apple-icon']

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

  const { pathname } = request.nextUrl
  if (user || isPublicPath(pathname)) return response

  const denied = pathname.startsWith('/api/')
    ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    : NextResponse.redirect(new URL('/login', request.url))
  response.cookies.getAll().forEach(cookie => denied.cookies.set(cookie))
  return denied
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?)$).*)'],
}
