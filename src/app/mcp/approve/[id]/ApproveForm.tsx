'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import FormError from '@/app/(auth)/_components/FormError'
import { useT } from '@/lib/i18n/client'
import type { DictKey } from '@/lib/i18n'
import { approve, reject, type ApproveFormResult } from './actions'

const REASON_KEYS: Record<Extract<ApproveFormResult, { ok: false }>['reason'], DictKey> = {
  not_found: 'mcp.approve.notFound',
  not_pending: 'mcp.approve.errors.notPending',
  expired: 'mcp.approve.expiredInfo',
  revoked: 'mcp.approve.revoked',
  state_changed: 'mcp.approve.changed',
  invalid_code: 'mcp.approve.errors.invalidCode',
  no_factor: 'mcp.approve.errors.noFactor',
  fresh_code: 'mcp.errors.freshCode',
  origin: 'mcp.approve.errors.origin',
  unauthorized: 'mcp.approve.errors.unauthorized',
  error: 'mcp.approve.errors.generic',
}

// Approve (with a current authenticator code when the owner asked for one) or reject. Either way
// the page reloads and shows what the database now holds.
export default function ApproveForm({ id, requireCode, canApprove }: { id: string; requireCode: boolean; canApprove: boolean }) {
  const { t } = useT()
  const router = useRouter()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [, startTransition] = useTransition()

  function run(which: 'approve' | 'reject') {
    setError(null)
    setBusy(which)
    startTransition(async () => {
      const result = await (which === 'approve' ? approve(id, code) : reject(id)).catch((): ApproveFormResult => ({ ok: false, reason: 'error' }))
      if (!result.ok) {
        // A changed state is shown by the page itself once it reloads, with what can be done about
        // it (a client or payments Claude changed are cleared in Mado), so it is not repeated here.
        if (result.reason !== 'state_changed') setError(t(REASON_KEYS[result.reason]))
        if (result.reason === 'invalid_code' || result.reason === 'fresh_code') setCode('')
      }
      setBusy(null)
      router.refresh()
    })
  }

  return (
    <form
      className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 sm:p-5 space-y-4"
      onSubmit={e => { e.preventDefault(); if (canApprove) run('approve') }}
    >
      {canApprove && requireCode && (
        <div className="space-y-1.5">
          <Label htmlFor="approve-code">{t('mcp.approve.code')}</Label>
          <Input
            id="approve-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            className="h-10 sm:h-10 text-center text-lg tracking-[0.4em] font-mono max-w-48"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            required
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('mcp.approve.codeHint')}</p>
        </div>
      )}
      <FormError message={error} />
      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
        <Button type="button" variant="outline" size="lg" disabled={busy !== null} onClick={() => run('reject')}>
          {busy === 'reject' ? t('mcp.approve.rejecting') : t('mcp.approve.rejectButton')}
        </Button>
        {canApprove && (
          <Button type="submit" size="lg" disabled={busy !== null || (requireCode && code.length !== 6)}>
            {busy === 'approve' ? t('mcp.approve.approving') : t('mcp.approve.approveButton')}
          </Button>
        )}
      </div>
    </form>
  )
}
