'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bot, Copy, LogOut, ShieldCheck, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import FormError from '@/app/(auth)/_components/FormError'
import { createClient } from '@/lib/supabase/client'
import { n } from '@/lib/i18n'
import { useT } from '@/lib/i18n/client'
import { formatDate } from '@/lib/utils/document'
import { ACTION_KINDS } from '@/lib/mcp/types'
import { rememberUiLang } from '@/app/auth/ui-lang'
import type { McpApproval, McpClientKind, McpConfirmPolicy, McpGrant } from '@/types'
import AccountCard from './AccountCard'
import { disconnectAllApps, disconnectApp, saveApprovalSettings } from './connected-apps-actions'

export type ConnectedGrant = Pick<McpGrant, 'id' | 'client_name' | 'client_kind' | 'redirect_uri' | 'scopes' | 'created_at' | 'last_used_at' | 'expires_at'>
export type RecentCall = { id: number; created_at: string; tool: string; ok: boolean; error_code: string | null; ms: number | null; client: string }

const SCOPE_LABELS = {
  'mado:read': 'mcp.consent.scopeRead',
  'mado:write': 'mcp.consent.scopeWrite',
  'mado:irreversible': 'mcp.consent.scopeIrreversible',
} as const

const KIND_LABELS: Record<McpClientKind, 'mcp.connectedApps.clientKinds.claude_ai' | 'mcp.connectedApps.clientKinds.claude_code' | 'mcp.connectedApps.clientKinds.static'> = {
  claude_ai: 'mcp.connectedApps.clientKinds.claude_ai',
  claude_code: 'mcp.connectedApps.clientKinds.claude_code',
  static: 'mcp.connectedApps.clientKinds.static',
}

const subhead = 'text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400'
const listClass = 'divide-y divide-neutral-100 dark:divide-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-800'

export default function ConnectedApps({ connectorUrl, grants, calls, pendingCount, policy, approvalCode }: {
  connectorUrl: string
  grants: ConnectedGrant[]
  calls: RecentCall[]
  pendingCount: number
  policy: McpConfirmPolicy
  approvalCode: boolean
}) {
  const { t, lang } = useT()
  const router = useRouter()
  const [removing, setRemoving] = useState<ConnectedGrant | null>(null)
  const [busy, setBusy] = useState(false)
  const [channels, setChannels] = useState<Record<string, McpApproval>>(() =>
    Object.fromEntries(ACTION_KINDS.map(kind => [kind, policy[kind] === 'chat' ? 'chat' : 'app'])))
  const [askCode, setAskCode] = useState(approvalCode)
  const [saving, setSaving] = useState(false)
  const [code, setCode] = useState('')
  const [policyError, setPolicyError] = useState<string | null>(null)
  const dirty = askCode !== approvalCode || ACTION_KINDS.some(kind => channels[kind] !== (policy[kind] === 'chat' ? 'chat' : 'app'))
  // Moving a kind to Claude or switching the code off loosens the approval: the server then asks
  // for a current authenticator code. Tightening saves without one.
  const loosening = (approvalCode && !askCode) || ACTION_KINDS.some(kind => channels[kind] === 'chat' && policy[kind] !== 'chat')

  const when = new Intl.DateTimeFormat(lang === 'de' ? 'de-AT' : 'en-GB', {
    timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(connectorUrl)
      toast.success(t('common.copied'))
    } catch {
      toast.error(t('account.genericError'))
    }
  }

  async function confirmDisconnect() {
    if (!removing) return
    setBusy(true)
    try {
      const result = await disconnectApp(removing.id)
      if (!result.ok) { toast.error(t('account.genericError')); return }
      setRemoving(null)
      toast.success(t('mcp.connectedApps.revoked'))
      router.refresh()
    } catch {
      toast.error(t('account.genericError'))
    } finally {
      setBusy(false)
    }
  }

  async function savePolicy(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setPolicyError(null)
    try {
      const result = await saveApprovalSettings(channels, askCode, loosening ? code : undefined)
      if (!result.ok) {
        if (result.reason === 'code' && !loosening) {
          // The stored settings changed since this page loaded (another tab): reload them, which
          // shows the code field.
          setPolicyError(t('mcp.connectedApps.loosenCodeHint'))
          router.refresh()
        } else if (result.reason === 'code') { setPolicyError(t('mcp.connectedApps.loosenCodeInvalid')); setCode('') }
        else if (result.reason === 'no_factor') setPolicyError(t('mcp.connectedApps.loosenNoFactor'))
        else toast.error(t('account.genericError'))
        return
      }
      setCode('')
      toast.success(t('mcp.connectedApps.policySaved'))
      router.refresh()
    } catch {
      toast.error(t('account.genericError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AccountCard id="account-connected-apps" title={t('mcp.connectedApps.title')} description={t('mcp.connectedApps.description')}>
      <div className="space-y-6">
        <div className="space-y-1.5">
          <p className={subhead}>{t('mcp.connectedApps.connectorUrl')}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-neutral-50 dark:bg-neutral-800 px-2.5 py-2 font-mono text-xs">{connectorUrl}</code>
            <button
              type="button"
              onClick={copyUrl}
              aria-label={t('common.copy')}
              className="h-11 w-11 sm:h-9 sm:w-9 shrink-0 flex items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              <Copy size={14} />
            </button>
          </div>
        </div>

        {grants.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('mcp.connectedApps.empty')}</p>
        ) : (
          <ul className={listClass}>
            {grants.map(grant => (
              <li key={grant.id} className="flex items-start gap-3 px-3 py-2.5">
                <Bot size={16} className="shrink-0 mt-0.5 text-neutral-400" aria-hidden="true" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-sm font-medium break-words">
                    {grant.client_name} <span className="font-normal text-neutral-500 dark:text-neutral-400">· {t(KIND_LABELS[grant.client_kind])}</span>
                  </p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {grant.scopes.filter((s): s is keyof typeof SCOPE_LABELS => s in SCOPE_LABELS).map(s => t(SCOPE_LABELS[s])).join(' · ')}
                  </p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t('mcp.connectedApps.connectedOn', { date: formatDate(grant.created_at, lang) })}
                    {' · '}
                    {grant.last_used_at ? t('mcp.connectedApps.lastUsed', { date: formatDate(grant.last_used_at, lang) }) : t('mcp.connectedApps.neverUsed')}
                    {' · '}
                    {t('mcp.connectedApps.endsOn', { date: formatDate(grant.expires_at, lang) })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setRemoving(grant)}
                  aria-label={`${t('mcp.connectedApps.revoke')}: ${grant.client_name}`}
                  className="h-11 w-11 sm:h-9 sm:w-9 -mr-2 shrink-0 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
                >
                  <Unplug size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className={subhead}>{t('mcp.connectedApps.approvalsTitle')}</p>
            <p className="text-sm mt-1">
              {pendingCount
                ? n(pendingCount, t('mcp.connectedApps.approvalsCountOne', { count: pendingCount }), t('mcp.connectedApps.approvalsCountOther', { count: pendingCount }))
                : t('mcp.connectedApps.approvalsNone')}
            </p>
          </div>
          {pendingCount > 0 && (
            <Link href="/mcp/approve" className="text-sm underline underline-offset-4">{t('mcp.connectedApps.approvalsOpen')}</Link>
          )}
        </div>

        <form onSubmit={savePolicy} className="space-y-3">
          <div>
            <p className={subhead}>{t('mcp.connectedApps.policyTitle')}</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{t('mcp.connectedApps.policyHint')}</p>
          </div>
          <ul className={listClass}>
            {ACTION_KINDS.map(kind => (
              <li key={kind} className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3 px-3 py-2">
                <label htmlFor={`policy-${kind}`} className="text-sm min-w-0 flex-1">{t(`mcp.connectedApps.kinds.${kind}`)}</label>
                <Select
                  id={`policy-${kind}`}
                  value={channels[kind]}
                  onChange={e => setChannels(c => ({ ...c, [kind]: e.target.value === 'chat' ? 'chat' : 'app' }))}
                  className="w-full sm:w-52"
                >
                  <option value="app">{t('mcp.connectedApps.channelApp')}</option>
                  <option value="chat">{t('mcp.connectedApps.channelChat')}</option>
                </Select>
              </li>
            ))}
          </ul>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={askCode} onChange={e => setAskCode(e.target.checked)} className="mt-0.5 accent-neutral-900 dark:accent-white" />
            <span className="min-w-0">
              <span className="inline-flex items-center gap-1.5"><ShieldCheck size={14} aria-hidden="true" />{t('mcp.connectedApps.approvalCode')}</span>
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t('mcp.connectedApps.approvalCodeHint')}</span>
            </span>
          </label>
          {loosening && (
            <div className="space-y-1.5">
              <Label htmlFor="policy-code">{t('mcp.connectedApps.loosenCodeLabel')}</Label>
              <Input
                id="policy-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                className="h-10 sm:h-10 text-center text-lg tracking-[0.4em] font-mono max-w-48"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                aria-describedby="policy-code-hint"
              />
              <p id="policy-code-hint" className="text-xs text-neutral-500 dark:text-neutral-400">{t('mcp.connectedApps.loosenCodeHint')}</p>
            </div>
          )}
          <FormError message={policyError} />
          <Button type="submit" className="h-10 sm:h-10 px-4" disabled={saving || !dirty || (loosening && code.length !== 6)}>
            {saving ? t('common.working') : t('mcp.connectedApps.savePolicy')}
          </Button>
        </form>

        <details className="group">
          <summary className={`${subhead} cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden`}>
            {t('mcp.connectedApps.callsTitle')} <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-180">▾</span>
          </summary>
          {calls.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">{t('mcp.connectedApps.callsEmpty')}</p>
          ) : (
            <ol className={`mt-2 ${listClass} text-xs`}>
              {calls.map(call => (
                <li key={call.id} className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-0.5 px-3 py-2">
                  <time dateTime={call.created_at} className="tabular-nums text-neutral-500 dark:text-neutral-400">{when.format(new Date(call.created_at))}</time>
                  <span className="min-w-0 truncate font-mono">{call.tool}</span>
                  <span className={call.ok ? 'text-neutral-500 dark:text-neutral-400' : 'text-red-600 dark:text-red-400'}>
                    {call.ok ? t('mcp.connectedApps.callOk') : t('mcp.connectedApps.callFailed', { code: call.error_code ?? '?' })}
                    {call.ms != null && <span className="text-neutral-400"> · {call.ms} ms</span>}
                  </span>
                  <span className="col-start-2 col-span-2 min-w-0 truncate text-neutral-500 dark:text-neutral-400">{call.client}</span>
                </li>
              ))}
            </ol>
          )}
        </details>
      </div>

      <ConfirmDialog
        open={removing !== null}
        title={t('mcp.connectedApps.revokeTitle')}
        description={t('mcp.connectedApps.revokeBody', { name: removing?.client_name ?? '' })}
        confirmLabel={busy ? t('common.working') : t('mcp.connectedApps.revoke')}
        destructive
        busy={busy}
        onConfirm={confirmDisconnect}
        onCancel={() => setRemoving(null)}
      />
    </AccountCard>
  )
}

// Ends every session of the account (scope 'global') after every Claude connection was revoked.
export function SignOutEverywhere() {
  const { t, lang } = useT()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function signOutEverywhere() {
    setBusy(true)
    // Signing out everywhere promises that Claude is disconnected too. When the connections could
    // not be revoked, stop before signing out: the owner is still signed in here and can try again.
    const result = await disconnectAllApps().catch(() => ({ ok: false as const }))
    if (!result.ok) {
      setBusy(false)
      toast.error(t('mcp.connectedApps.signOutEverywhereFailed'))
      return
    }
    rememberUiLang(lang)
    await createClient().auth.signOut({ scope: 'global' }).catch(() => {})
    window.location.assign('/login')
  }

  return (
    <AccountCard id="account-sign-out-everywhere" title={t('mcp.connectedApps.signOutEverywhere')} description={t('mcp.connectedApps.signOutEverywhereHint')}>
      <Button type="button" variant="outline" className="h-10 sm:h-10 px-4" onClick={() => setOpen(true)}>
        <LogOut size={16} /> {t('mcp.connectedApps.signOutEverywhere')}
      </Button>
      <ConfirmDialog
        open={open}
        title={t('mcp.connectedApps.signOutEverywhereTitle')}
        description={t('mcp.connectedApps.signOutEverywhereBody')}
        confirmLabel={busy ? t('common.working') : t('mcp.connectedApps.signOutEverywhere')}
        destructive
        busy={busy}
        onConfirm={signOutEverywhere}
        onCancel={() => setOpen(false)}
      />
    </AccountCard>
  )
}
