'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useT } from '@/lib/i18n/client'
import { n } from '@/lib/i18n'
import { apiErrorMessage, requestErrorMessage } from '@/lib/api-errors'

// Applies every issued credit note that still could reduce its invoice's open balance.
export default function ApplyCreditNotesButton() {
  const [busy, setBusy] = useState(false)
  const router = useRouter()
  const { t } = useT()

  async function applyAll() {
    setBusy(true)
    try {
      const res = await fetch('/api/credit-notes/apply-all', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(apiErrorMessage(t, data)); return }
      const applied: number = data.applied ?? 0
      const failed: string[] = data.failed ?? []
      if (applied) toast.success(n(applied, t('lifecycle.credit.appliedAllOne', { count: applied }), t('lifecycle.credit.appliedAllOther', { count: applied })))
      if (failed.length) toast.error(t('lifecycle.credit.applyAllFailed', { list: failed.join('; ') }))
      if (!applied && !failed.length) toast.info(t('lifecycle.credit.applyAllNone'))
      router.refresh()
    } catch (err) {
      toast.error(requestErrorMessage(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void applyAll()}
      disabled={busy}
      className="shrink-0 text-xs font-medium px-3 py-2 sm:py-1.5 rounded-md border border-amber-300 dark:border-amber-800 bg-white/60 dark:bg-transparent hover:bg-amber-100 dark:hover:bg-amber-950/60 transition-colors disabled:opacity-50"
    >
      {busy ? t('lifecycle.credit.applyingAll') : t('lifecycle.credit.applyAll')}
    </button>
  )
}
