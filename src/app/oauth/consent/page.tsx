import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import { consentOwner } from '@/lib/mcp/oauth/owner'
import { readAuthRequest } from '@/lib/mcp/oauth/request'
import { isLoopbackRedirect } from '@/lib/mcp/oauth/clients'
import { ACTION_KINDS } from '@/lib/mcp/types'
import type { McpConfirmPolicy } from '@/types'
import ConsentForm from './ConsentForm'

const card = 'rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 sm:p-6 space-y-3'

export default async function ConsentPage({ searchParams }: { searchParams: Promise<{ r?: string | string[] }> }) {
  const { r } = await searchParams
  const blob = typeof r === 'string' ? r : null
  const { t } = await getT()
  const request = readAuthRequest(blob)
  const supabase = await createClient()
  const owner = request ? await consentOwner(supabase) : null

  if (!request || !blob || !owner || owner.status !== 'ok') {
    const message = !request ? t('mcp.consent.expired') : owner?.status === 'no_factor' ? t('mcp.consent.needsFactor') : t('mcp.consent.notOwner')
    return (
      <div className={card}>
        <h1 className="text-lg font-semibold">{t('mcp.consent.title')}</h1>
        <p role="alert" className="text-sm text-neutral-600 dark:text-neutral-300">{message}</p>
        {owner?.status === 'no_factor' && (
          <Link href="/account#account-mfa" className="inline-block text-sm underline underline-offset-4">{t('mcp.consent.setUpFactor')}</Link>
        )}
      </div>
    )
  }

  // Before the migration the columns are missing: every kind is approved in Mado with a code.
  const { data: settings } = await supabase.from('settings').select('mcp_confirm_policy, mcp_approval_totp').maybeSingle()
  const policy = (settings?.mcp_confirm_policy ?? {}) as McpConfirmPolicy
  const chatKinds = ACTION_KINDS.filter(kind => policy[kind] === 'chat')

  return (
    <ConsentForm
      blob={blob}
      clientName={request.clientName}
      clientKind={request.clientKind}
      redirectHost={new URL(request.redirectUri).host}
      loopback={isLoopbackRedirect(request.redirectUri)}
      requestedScopes={request.scopes}
      chatKinds={chatKinds}
      approvalCode={settings?.mcp_approval_totp !== false}
    />
  )
}
