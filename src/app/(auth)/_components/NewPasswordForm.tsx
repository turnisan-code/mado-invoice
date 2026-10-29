'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { useT } from '@/lib/i18n/client'
import { authErrorKey } from './auth-errors'
import FormError from './FormError'

const MIN_PASSWORD_LENGTH = 12

// Used by /reset-password (recovery session) and the account page (signed-in session).
export default function NewPasswordForm({ email, redirectTo }: { email: string; redirectTo?: string }) {
  const { t } = useT()
  const router = useRouter()
  const id = useId()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (password.length < MIN_PASSWORD_LENGTH) { setError(t('account.passwordTooShort', { min: MIN_PASSWORD_LENGTH })); return }
    if (password !== confirm) { setError(t('account.passwordMismatch')); return }
    setBusy(true)
    setError(null)
    try {
      const supabase = createClient()
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) { setError(t(authErrorKey(updateError))); return }
      // Whoever knew the old password may still hold a session elsewhere.
      await supabase.auth.signOut({ scope: 'others' })
      setPassword('')
      setConfirm('')
      toast.success(t('account.passwordSaved'))
      if (redirectTo) router.replace(redirectTo)
    } catch {
      setError(t('account.genericError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {/* Lets password managers file the new password under the right account. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-new`}>{t('account.newPassword')}</Label>
        <Input
          id={`${id}-new`}
          type="password"
          autoComplete="new-password"
          className="h-10 sm:h-10"
          value={password}
          onChange={e => setPassword(e.target.value)}
          aria-describedby={`${id}-rule`}
          required
        />
        <p id={`${id}-rule`} className="text-xs text-neutral-500 dark:text-neutral-400">
          {t('account.passwordRule', { min: MIN_PASSWORD_LENGTH })}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-confirm`}>{t('account.confirmPassword')}</Label>
        <Input
          id={`${id}-confirm`}
          type="password"
          autoComplete="new-password"
          className="h-10 sm:h-10"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          required
        />
      </div>
      <FormError message={error} />
      <Button type="submit" className="h-10 sm:h-10 w-full sm:w-auto px-4" disabled={busy}>
        {busy ? t('common.saving') : t('account.savePassword')}
      </Button>
    </form>
  )
}
