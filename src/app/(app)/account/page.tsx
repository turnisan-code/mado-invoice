import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import { RESOURCE } from '@/lib/mcp/config'
import NewPasswordForm from '@/app/(auth)/_components/NewPasswordForm'
import type { McpConfirmPolicy } from '@/types'
import AccountCard from './AccountCard'
import ConnectedApps, { SignOutEverywhere, type ConnectedGrant, type RecentCall } from './ConnectedApps'
import TwoFactorSettings from './TwoFactorSettings'

type CallRow = Omit<RecentCall, 'client'> & { grant_id: string }

export default async function AccountPage() {
  const supabase = await createClient()
  const { t } = await getT()
  const { data: { user } } = await supabase.auth.getUser()
  const email = user?.email ?? ''
  const factors = (user?.factors ?? []).filter(f => f.factor_type === 'totp' && f.status === 'verified')

  // Before the connector's migration these reads fail: the section then shows nothing connected.
  const [{ data: grants }, { count: pending }, { data: callRows }, { data: settings }] = await Promise.all([
    supabase.from('mcp_grants').select('id, client_name, client_kind, redirect_uri, scopes, created_at, last_used_at, expires_at')
      .is('revoked_at', null).order('created_at', { ascending: false }),
    supabase.from('mcp_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending').gt('expires_at', new Date().toISOString()),
    supabase.from('mcp_calls').select('id, grant_id, tool, ok, error_code, ms, created_at').order('created_at', { ascending: false }).limit(50),
    supabase.from('settings').select('mcp_confirm_policy, mcp_approval_totp').maybeSingle(),
  ])
  const calls = (callRows ?? []) as CallRow[]
  const grantIds = [...new Set(calls.map(c => c.grant_id))]
  const { data: names } = grantIds.length
    ? await supabase.from('mcp_grants').select('id, client_name').in('id', grantIds)
    : { data: [] }
  const nameOf = new Map((names ?? []).map(g => [g.id as string, g.client_name as string]))

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
      <ConnectedApps
        connectorUrl={RESOURCE}
        grants={(grants ?? []) as ConnectedGrant[]}
        calls={calls.map(({ grant_id, ...call }) => ({ ...call, client: nameOf.get(grant_id) ?? '—' }))}
        pendingCount={pending ?? 0}
        policy={(settings?.mcp_confirm_policy ?? {}) as McpConfirmPolicy}
        approvalCode={settings?.mcp_approval_totp !== false}
      />
      <SignOutEverywhere />
    </div>
  )
}
