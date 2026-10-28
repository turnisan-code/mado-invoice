import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import NewPasswordForm from '@/app/(auth)/_components/NewPasswordForm'
import AccountCard from './AccountCard'
import TwoFactorSettings from './TwoFactorSettings'

export default async function AccountPage() {
  const supabase = await createClient()
  const { t } = await getT()
  const { data: { user } } = await supabase.auth.getUser()
  const email = user?.email ?? ''
  const factors = (user?.factors ?? []).filter(f => f.factor_type === 'totp' && f.status === 'verified')

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('account.title')}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{t('account.subtitle')}</p>
        {email && <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('account.signedInAs', { email })}</p>}
      </div>
      <AccountCard id="account-password" title={t('account.passwordSection')} description={t('account.passwordSectionHint')}>
        <div className="max-w-sm">
          <NewPasswordForm email={email} />
        </div>
      </AccountCard>
      <TwoFactorSettings initialFactors={factors} />
    </div>
  )
}
