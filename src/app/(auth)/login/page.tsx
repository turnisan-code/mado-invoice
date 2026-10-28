import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { safeNextPath } from '@/app/auth/safe-next'
import { pendingTotpFactor } from '@/app/auth/mfa'
import LoginForm from './LoginForm'

type Query = Record<'next' | 'error', string | string[] | undefined>

export default async function LoginPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams
  const param = (key: keyof Query) => { const value = query[key]; return typeof value === 'string' ? value : null }
  const next = safeNextPath(param('next'))

  // A password-only session of an owner with an authenticator lands here (the proxy adds ?mfa=1)
  // and continues with the code step instead of the password form.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const mfaFactorId = user ? await pendingTotpFactor(supabase.auth, user) : null
  if (user && !mfaFactorId) redirect(next)

  return <LoginForm next={next} linkError={param('error') === 'link'} mfaFactorId={mfaFactorId} />
}
