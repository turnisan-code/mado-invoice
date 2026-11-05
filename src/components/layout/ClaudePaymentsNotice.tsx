'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n/client'
import { dbErrorMessage } from '@/lib/api-errors'

// An issued invoice whose payments, or a credit note whose refunds, a Claude session recorded,
// changed or removed, or a credit note it applied to its invoice (documents.mcp_payments_at,
// 20261105_mcp_drafts.sql): the reminder cron skips
// the invoice, the automatic Bookamat step the document, and no archive copy is made of it, until
// the owner has checked the payments and confirms them here, whatever its status (a paid invoice
// is what the Bookamat step books). Confirming clears the mark; a Claude session cannot
// (documents_mcp_payments_guard).
export default function ClaudePaymentsNotice({ documentId, kind }: { documentId: string; kind: 'invoice' | 'credit_note' }) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()
  const { t } = useT()

  async function confirm() {
    setBusy(true)
    const { error } = await createClient().from('documents').update({ mcp_payments_at: null }).eq('id', documentId)
    setBusy(false)
    if (error) { toast.error(dbErrorMessage(t, error)); return }
    toast.success(t(kind === 'invoice' ? 'payments.claudeChanged.confirmed' : 'payments.claudeChanged.confirmedCreditNote'))
    router.refresh()
  }

  return (
    <div role="status" className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300">
      <p className="flex-1">{t(kind === 'invoice' ? 'payments.claudeChanged.notice' : 'payments.claudeChanged.noticeCreditNote')}</p>
      <Button
        type="button"
        variant="outline"
        onClick={() => void confirm()}
        disabled={busy}
        className="shrink-0 text-xs border-amber-300 dark:border-amber-800 bg-white/60 dark:bg-transparent hover:bg-amber-100 dark:hover:bg-amber-950/60"
      >
        {t(kind === 'invoice' ? 'payments.claudeChanged.confirm' : 'payments.claudeChanged.confirmCreditNote')}
      </Button>
    </div>
  )
}
