'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { useT } from '@/lib/i18n/client'
import { pendingTotpFactor } from '@/app/auth/mfa'
import { authErrorKey } from '../_components/auth-errors'
import FormError from '../_components/FormError'

type Step = 'password' | 'forgot' | 'sent' | 'mfa'

const linkButton = 'py-1 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 underline-offset-4 hover:underline rounded'

export default function LoginForm({ next, linkError, mfaFactorId }: { next: string; linkError: boolean; mfaFactorId: string | null }) {
  const { t } = useT()
  const [step, setStep] = useState<Step>(mfaFactorId ? 'mfa' : linkError ? 'forgot' : 'password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [factorId, setFactorId] = useState(mfaFactorId)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(linkError ? t('account.linkInvalid') : null)
  const [busy, setBusy] = useState(false)

  function goTo(nextStep: Step) {
    setError(null)
    setStep(nextStep)
  }

  // A full load, so the root layout re-reads the UI language and the session cookies.
  function enterApp() {
    window.location.assign(next)
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const supabase = createClient()
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
      if (signInError) {
        setError(t(authErrorKey(signInError)))
      } else {
        const pending = await pendingTotpFactor(supabase.auth, data.user)
        // Stays busy while the app loads, so a second click cannot start another sign-in.
        if (!pending) { enterApp(); return }
        setPassword('')
        setFactorId(pending)
        setStep('mfa')
      }
    } catch {
      setError(t('account.genericError'))
    }
    setBusy(false)
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault()
    if (!factorId) return
    setBusy(true)
    setError(null)
    try {
      const { error: verifyError } = await createClient().auth.mfa.challengeAndVerify({ factorId, code })
      if (!verifyError) { enterApp(); return }
      setError(t(authErrorKey(verifyError)))
      setCode('')
    } catch {
      setError(t('account.genericError'))
    }
    setBusy(false)
  }

  // Leaves no half-signed-in (aal1) session behind.
  async function cancelMfa() {
    setBusy(true)
    await createClient().auth.signOut().catch(() => {})
    setBusy(false)
    setFactorId(null)
    setCode('')
    goTo('password')
  }

  // The confirmation never depends on the outcome, so the form cannot be used to probe which addresses have an account.
  async function requestReset(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { error: resetError } = await createClient().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      })
      if (resetError) console.error('[login] password reset request failed:', resetError.message)
    } catch (err) {
      console.error('[login] password reset request failed:', err)
    } finally {
      setBusy(false)
    }
    setStep('sent')
  }

  if (step === 'mfa') {
    return (
      <form onSubmit={verifyCode} className="space-y-4">
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-semibold">{t('account.mfaTitle')}</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('account.mfaPrompt')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mfa-code">{t('account.code')}</Label>
          <Input
            id="mfa-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            autoFocus
            className="h-10 text-center text-lg tracking-[0.4em] font-mono"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            required
          />
        </div>
        <FormError message={error} />
        <Button type="submit" className="h-10 w-full" disabled={busy || code.length !== 6}>
          {busy ? t('account.verifying') : t('account.verify')}
        </Button>
        <div className="text-center">
          <button type="button" onClick={cancelMfa} disabled={busy} className={linkButton}>{t('account.signOutInstead')}</button>
        </div>
      </form>
    )
  }

  if (step === 'sent') {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-lg font-semibold">{t('account.forgotTitle')}</h1>
        <p role="status" className="text-sm text-neutral-600 dark:text-neutral-300">{t('account.resetLinkSent', { email })}</p>
        <button type="button" onClick={() => goTo('password')} className={linkButton}>{t('account.backToSignIn')}</button>
      </div>
    )
  }

  if (step === 'forgot') {
    return (
      <form onSubmit={requestReset} className="space-y-4">
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-semibold">{t('account.forgotTitle')}</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('account.forgotHint')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reset-email">{t('account.email')}</Label>
          <Input
            id="reset-email"
            type="email"
            autoComplete="username"
            className="h-10"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder={t('account.emailPlaceholder')}
            required
          />
        </div>
        <FormError message={error} />
        <Button type="submit" className="h-10 w-full" disabled={busy}>
          {busy ? t('common.sending') : t('account.sendResetLink')}
        </Button>
        <div className="text-center">
          <button type="button" onClick={() => goTo('password')} className={linkButton}>{t('account.backToSignIn')}</button>
        </div>
      </form>
    )
  }

  return (
    <form onSubmit={signIn} className="space-y-4">
      <h1 className="text-lg font-semibold text-center">{t('account.signInTitle')}</h1>
      <div className="space-y-1.5">
        <Label htmlFor="email">{t('account.email')}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          className="h-10"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder={t('account.emailPlaceholder')}
          required
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="password">{t('account.password')}</Label>
          <button type="button" onClick={() => goTo('forgot')} className={linkButton}>{t('account.forgotPassword')}</button>
        </div>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          className="h-10"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
        />
      </div>
      <FormError message={error} />
      <Button type="submit" className="h-10 w-full" disabled={busy}>
        {busy ? t('account.signingIn') : t('account.signIn')}
      </Button>
    </form>
  )
}
