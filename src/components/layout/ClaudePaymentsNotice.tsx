'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n/client'
import { dbErrorMessage } from '@/lib/api-errors'

// An open invoice whose payments a Claude session recorded, changed or removed
// (documents.mcp_payments_at, 20261105_mcp_drafts.sql): the reminder cron skips it until the owner
// has checked the payments and confirms them here. Confirming clears the mark; a Claude session
// cannot (documents_mcp_payments_guard).
export default function ClaudePaymentsNotice({ documentId }: { documentId: string }) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()
  const { t } = useT()

  async function confirm() {
    setBusy(true)
    const { error } = await createClient().from('documents').update({ mcp_payments_at: null }).eq('id', documentId)
    setBusy(false)
    if (error) { toast.error(dbErrorMessage(t, error)); return }
    toast.success(t('payments.claudeChanged.confirmed'))
    router.refresh()
  }

  return (
    <div role="status" className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300">
      <p className="flex-1">{t('payments.claudeChanged.notice')}</p>
      <Button
        type="button"
        variant="outline"
        onClick={() => void confirm()}
        disabled={busy}
        className="shrink-0 text-xs border-amber-300 dark:border-amber-800 bg-white/60 dark:bg-transparent hover:bg-amber-100 dark:hover:bg-amber-950/60"
      >
        {t('payments.claudeChanged.confirm')}
      </Button>
    </div>
  )
}
