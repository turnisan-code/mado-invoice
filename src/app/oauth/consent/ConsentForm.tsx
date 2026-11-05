'use client'

import { useActionState, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useT } from '@/lib/i18n/client'
import { MCP_SCOPES, type McpScope } from '@/lib/mcp/config'
import type { McpActionKind, McpClientKind } from '@/types'
import FormError from '@/app/(auth)/_components/FormError'
import { answerConsent, type ConsentState } from './actions'

const SCOPE_KEYS = {
  'mado:read': { label: 'mcp.consent.scopeRead', hint: 'mcp.consent.scopeReadHint' },
  'mado:write': { label: 'mcp.consent.scopeWrite', hint: 'mcp.consent.scopeWriteHint' },
  'mado:irreversible': { label: 'mcp.consent.scopeIrreversible', hint: 'mcp.consent.scopeIrreversibleHint' },
} as const

const KIND_KEYS = {
  claude_ai: 'mcp.consent.kindClaudeAi',
  claude_code: 'mcp.consent.kindClaudeCode',
  static: 'mcp.consent.kindStatic',
} as const

const ERROR_KEYS = {
  code: 'mcp.consent.errorCode',
  expired: 'mcp.consent.expired',
  used: 'mcp.consent.used',
  owner: 'mcp.consent.notOwner',
  failed: 'mcp.consent.errorFailed',
} as const

export default function ConsentForm({ blob, clientName, clientKind, redirectHost, loopback, requestedScopes, chatKinds, approvalCode }: {
  blob: string
  clientName: string
  clientKind: McpClientKind
  redirectHost: string
  loopback: boolean
  requestedScopes: McpScope[]
  chatKinds: McpActionKind[]
  approvalCode: boolean
}) {
  const { t } = useT()
  const [state, action, pending] = useActionState<ConsentState, FormData>(answerConsent, null)
  const [code, setCode] = useState('')
  // Reading is always granted, so it is always shown, even when Claude asked only for more.
  const offered = MCP_SCOPES.filter(s => s === 'mado:read' || requestedScopes.includes(s))

  return (
    <form action={action} className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 sm:p-6 space-y-5">
      <input type="hidden" name="r" value={blob} />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t('mcp.consent.title')}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('mcp.consent.intro', { client: clientName })}</p>
      </div>

      <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-neutral-500 dark:text-neutral-400">{t('mcp.consent.clientLabel')}</dt>
        <dd className="min-w-0 break-words">{t(KIND_KEYS[clientKind])}</dd>
        <dt className="text-neutral-500 dark:text-neutral-400">{t('mcp.consent.returnsTo')}</dt>
        <dd className="min-w-0 break-all font-mono text-xs leading-5">{redirectHost}</dd>
      </dl>

      {loopback && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>{t('mcp.consent.loopbackWarning')}</span>
        </p>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium mb-1">{t('mcp.consent.scopesTitle')}</legend>
        {offered.map(scope => (
          <label key={scope} className="flex items-start gap-3 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              name="scope"
              value={scope}
              defaultChecked
              disabled={scope === 'mado:read'}
              className="mt-0.5 accent-neutral-900 dark:accent-white"
            />
            <span className="min-w-0">
              <span className="font-medium">{t(SCOPE_KEYS[scope].label)}</span>
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t(SCOPE_KEYS[scope].hint)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {approvalCode ? t('mcp.consent.policyApp') : t('mcp.consent.policyAppNoCode')}
        {chatKinds.length > 0 && <> {t('mcp.consent.policyChat', { kinds: chatKinds.map(k => t(`mcp.connectedApps.kinds.${k}`)).join(', ') })}</>}
        {' '}{t('mcp.consent.policyChange')}
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="consent-code">{t('mcp.consent.codeLabel')}</Label>
        <Input
          id="consent-code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          className="h-10 sm:h-10 text-center text-lg tracking-[0.4em] font-mono"
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          aria-describedby="consent-code-hint"
        />
        <p id="consent-code-hint" className="text-xs text-neutral-500 dark:text-neutral-400">{t('mcp.consent.codeHint')}</p>
      </div>

      <FormError message={state ? t(ERROR_KEYS[state.error]) : null} />

      {/* Approve comes first in the DOM, so Enter in the code field approves rather than denies. */}
      <div className="flex flex-col sm:flex-row-reverse gap-2">
        <Button type="submit" name="decision" value="approve" className="h-10 sm:h-10 px-4" disabled={pending || code.length !== 6}>
          {pending ? t('common.working') : t('mcp.consent.approve')}
        </Button>
        <Button type="submit" name="decision" value="deny" variant="outline" className="h-10 sm:h-10 px-4" disabled={pending}>
          {t('mcp.consent.deny')}
        </Button>
      </div>
    </form>
  )
}
