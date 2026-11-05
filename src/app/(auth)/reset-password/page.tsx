import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import NewPasswordForm from '../_components/NewPasswordForm'

// Reached through /auth/callback with the recovery session that the email link created. The proxy
// keeps this page behind sign-in and, for owners with a verified authenticator, behind the code
// step too: Supabase only lets an aal2 session change the password once MFA is on.
export default async function ResetPasswordPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) redirect('/login?error=link')
  const { t } = await getT()

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-center">
        <h1 className="text-lg font-semibold">{t('account.resetTitle')}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('account.resetHint', { email: user.email })}</p>
      </div>
      <NewPasswordForm email={user.email} redirectTo="/dashboard" />
    </div>
  )
}
