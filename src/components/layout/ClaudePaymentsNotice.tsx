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
// (documents_mcp_payments_guard). Only the mark the page was rendered with (`seenAt`, read with the
// payments it lists) is cleared: a later change from Claude moves it forward, and that one the
// owner has not seen, so the page reloads instead. A mark already cleared (confirmed in another tab
// or on another device since this page was loaded) is said to be so, not as a change from Claude.
// `clientHeld`: the document's client carries Claude's mark too (clients.mcp_written_at, shown by
// ClaudeClientNotice), so the reminders and the Bookamat sync still wait for the client to be
// saved, and the toast says so.
export default function ClaudePaymentsNotice({ documentId, kind, seenAt, clientHeld = false }: { documentId: string; kind: 'invoice' | 'credit_note'; seenAt: string; clientHeld?: boolean }) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()
  const { t } = useT()

  async function confirm() {
    setBusy(true)
    const supabase = createClient()
    const { data, error } = await supabase.from('documents').update({ mcp_payments_at: null }).eq('id', documentId).eq('mcp_payments_at', seenAt).select('id')
    if (error) { setBusy(false); toast.error(dbErrorMessage(t, error)); return }
    if (!data?.length) {
      // Not the mark this page shows: confirmed meanwhile (no mark left), or Claude changed the
      // payments again (a newer one).
      const { data: now, error: readError } = await supabase.from('documents').select('mcp_payments_at').eq('id', documentId).maybeSingle()
      setBusy(false)
      if (readError) toast.error(dbErrorMessage(t, readError))
      else if (now && now.mcp_payments_at === null) toast.info(t(kind === 'invoice' ? 'payments.claudeChanged.alreadyConfirmed' : 'payments.claudeChanged.alreadyConfirmedCreditNote'))
      else toast.error(t(kind === 'invoice' ? 'payments.claudeChanged.changedAgain' : 'payments.claudeChanged.changedAgainCreditNote'))
      router.refresh()
      return
    }
    setBusy(false)
    toast.success(t(kind === 'invoice'
      ? (clientHeld ? 'payments.claudeChanged.confirmedClientHeld' : 'payments.claudeChanged.confirmed')
      : (clientHeld ? 'payments.claudeChanged.confirmedCreditNoteClientHeld' : 'payments.claudeChanged.confirmedCreditNote')))
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
