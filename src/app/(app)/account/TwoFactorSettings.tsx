'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Copy, ShieldCheck, Smartphone, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Factor } from '@supabase/supabase-js'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { createClient } from '@/lib/supabase/client'
import { useT } from '@/lib/i18n/client'
import { formatDate } from '@/lib/utils/document'
import { authErrorKey } from '@/app/(auth)/_components/auth-errors'
import FormError from '@/app/(auth)/_components/FormError'
import AccountCard from './AccountCard'

type Enrollment = { id: string; qr: string; secret: string }

const SVG_PREFIX = 'data:image/svg+xml;utf-8,'

// supabase-js prefixes the raw SVG markup without encoding it, so a '#' in it would end the data URI.
function qrDataUri(qr: string) {
  return qr.startsWith(SVG_PREFIX)
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.slice(SVG_PREFIX.length))}`
    : qr
}

export default function TwoFactorSettings({ initialFactors }: { initialFactors: Factor[] }) {
  const { t, lang } = useT()
  const [factors, setFactors] = useState(initialFactors)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Factor | null>(null)

  const active = factors.length > 0

  async function reloadFactors() {
    const { data } = await createClient().auth.mfa.listFactors()
    if (data) setFactors(data.totp)
  }

  function openNaming() {
    setError(null)
    setName(t('account.factorDefaultName'))
    setNaming(true)
  }

  async function startEnrollment(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { mfa } = createClient().auth
      // An abandoned set-up leaves an unverified factor behind, which would block reusing its name.
      const { data: list } = await mfa.listFactors()
      for (const factor of list?.all ?? []) {
        if (factor.factor_type === 'totp' && factor.status === 'unverified') await mfa.unenroll({ factorId: factor.id })
      }
      const { data, error: enrollError } = await mfa.enroll({
        factorType: 'totp',
        friendlyName: name.trim() || t('account.factorDefaultName'),
        issuer: 'Mado Invoice',
      })
      if (enrollError) { setError(t(authErrorKey(enrollError))); return }
      setEnrollment({ id: data.id, qr: qrDataUri(data.totp.qr_code), secret: data.totp.secret })
      setNaming(false)
      setCode('')
    } catch {
      setError(t('account.genericError'))
    } finally {
      setBusy(false)
    }
  }

  async function activate(e: React.FormEvent) {
    e.preventDefault()
    if (!enrollment) return
    setBusy(true)
    setError(null)
    try {
      // Verifying also lifts this session to aal2, so the new requirement cannot lock it out.
      const { error: verifyError } = await createClient().auth.mfa.challengeAndVerify({ factorId: enrollment.id, code })
      if (verifyError) { setError(t(authErrorKey(verifyError))); setCode(''); return }
      setEnrollment(null)
      setCode('')
      await reloadFactors()
      toast.success(t('account.mfaActivated'))
    } catch {
      setError(t('account.genericError'))
    } finally {
      setBusy(false)
    }
  }

  async function cancelSetup() {
    const pending = enrollment
    setEnrollment(null)
    setNaming(false)
    setCode('')
    setError(null)
    if (pending) await createClient().auth.mfa.unenroll({ factorId: pending.id }).catch(() => {})
  }

  async function confirmRemove() {
    if (!removing) return
    setBusy(true)
    try {
      const { error: removeError } = await createClient().auth.mfa.unenroll({ factorId: removing.id })
      if (removeError) { toast.error(t(authErrorKey(removeError))); return }
      setRemoving(null)
      await reloadFactors()
      toast.success(t('account.factorRemoved'))
    } catch {
      toast.error(t('account.genericError'))
    } finally {
      setBusy(false)
    }
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret)
      toast.success(t('common.copied'))
    } catch {
      toast.error(t('account.genericError'))
    }
  }

  const status = (
    <span className={active
      ? 'shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400'
      : 'shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'}
    >
      {active && <ShieldCheck size={12} aria-hidden="true" />}
      {active ? t('account.mfaStatusOn') : t('account.mfaStatusOff')}
    </span>
  )

  return (
    <AccountCard id="account-mfa" title={t('account.mfaSection')} description={t('account.mfaSectionHint')} aside={status}>
      <div className="space-y-5">
        {active && (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-800">
            {factors.map(factor => (
              <li key={factor.id} className="flex items-center gap-3 px-3 py-2">
                <Smartphone size={16} className="shrink-0 text-neutral-400" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{factor.friendly_name || t('account.factorDefaultName')}</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('account.factorAdded', { date: formatDate(factor.created_at, lang) })}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setRemoving(factor)}
                  aria-label={`${t('account.factorRemove')}: ${factor.friendly_name || t('account.factorDefaultName')}`}
                  className="h-11 w-11 sm:h-9 sm:w-9 -mr-2 shrink-0 flex items-center justify-center rounded-md text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {!naming && !enrollment && (
          <div className="space-y-3">
            <Button type="button" variant={active ? 'outline' : 'default'} className="h-10 px-4" onClick={openNaming}>
              {active ? t('account.mfaAddAnother') : t('account.mfaSetUp')}
            </Button>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('account.mfaBackupTip')}</p>
          </div>
        )}

        {naming && (
          <form onSubmit={startEnrollment} className="space-y-4 max-w-sm">
            <div className="space-y-1.5">
              <Label htmlFor="factor-name">{t('account.factorName')}</Label>
              <Input
                id="factor-name"
                className="h-10"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={60}
                aria-describedby="factor-name-hint"
              />
              <p id="factor-name-hint" className="text-xs text-neutral-500 dark:text-neutral-400">{t('account.factorNameHint')}</p>
            </div>
            <FormError message={error} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="h-10 px-4" disabled={busy}>{busy ? t('common.working') : t('account.mfaContinue')}</Button>
              <Button type="button" variant="outline" className="h-10 px-4" onClick={cancelSetup} disabled={busy}>{t('common.cancel')}</Button>
            </div>
          </form>
        )}

        {enrollment && (
          <form onSubmit={activate} className="space-y-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('account.mfaScan')}</p>
            <div className="flex flex-col sm:flex-row gap-4 sm:items-start">
              <Image
                src={enrollment.qr}
                alt={t('account.qrAlt')}
                width={176}
                height={176}
                unoptimized
                className="shrink-0 self-center sm:self-start rounded-lg border border-neutral-200 bg-white p-2"
              />
              <div className="min-w-0 space-y-1.5">
                <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('account.secret')}</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 break-all font-mono text-sm tracking-wider">{enrollment.secret.match(/.{1,4}/g)?.join(' ')}</code>
                  <button
                    type="button"
                    onClick={() => copySecret(enrollment.secret)}
                    aria-label={t('account.copySecret')}
                    className="h-11 w-11 sm:h-8 sm:w-8 shrink-0 flex items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              </div>
            </div>
            <div className="space-y-1.5 max-w-xs">
              <Label htmlFor="enroll-code">{t('account.mfaEnterCode')}</Label>
              <Input
                id="enroll-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                className="h-10 text-center text-lg tracking-[0.4em] font-mono"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
              />
            </div>
            <FormError message={error} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="h-10 px-4" disabled={busy || code.length !== 6}>
                {busy ? t('account.verifying') : t('account.activate')}
              </Button>
              <Button type="button" variant="outline" className="h-10 px-4" onClick={cancelSetup} disabled={busy}>{t('common.cancel')}</Button>
            </div>
          </form>
        )}
      </div>

      <ConfirmDialog
        open={removing !== null}
        title={t('account.factorRemoveTitle', { name: removing?.friendly_name || t('account.factorDefaultName') })}
        description={factors.length <= 1 ? t('account.factorRemoveLast') : t('account.factorRemoveOther')}
        confirmLabel={busy ? t('common.removing') : t('account.factorRemove')}
        destructive
        busy={busy}
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      />
    </AccountCard>
  )
}
