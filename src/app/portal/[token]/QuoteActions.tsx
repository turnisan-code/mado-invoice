'use client'

import { useState } from 'react'
import { CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

// pdfPortal.portal.quote.*, in the quote's language (resolved by the server page).
export type QuoteActionLabels = Record<
  'accept' | 'decline' | 'cancel' | 'accepted' | 'declined' | 'confirmAccept' | 'confirmDecline' | 'acceptHint' | 'declineHint' | 'failed',
  string
>

export default function QuoteActions({ token, labels }: { token: string; labels: QuoteActionLabels }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'accepted' | 'rejected'>('idle')
  const [pending, setPending] = useState<'accepted' | 'rejected' | null>(null)
  const [failed, setFailed] = useState(false)

  async function respond(action: 'accepted' | 'rejected') {
    setStatus('loading')
    setFailed(false)
    let ok = false
    try {
      const res = await fetch(`/api/portal/${token}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      ok = res.ok
    } catch {
      ok = false
    }
    setPending(null)
    setFailed(!ok)
    setStatus(ok ? action : 'idle')
  }

  if (status === 'accepted') {
    return (
      <div className="flex items-center gap-2 text-green-700 text-sm font-medium" role="status">
        <CheckCircle size={15} aria-hidden="true" />
        {labels.accepted}
      </div>
    )
  }

  if (status === 'rejected') {
    return (
      <div className="flex items-center gap-2 text-neutral-500 text-sm" role="status">
        <XCircle size={15} aria-hidden="true" />
        {labels.declined}
      </div>
    )
  }

  const busy = status === 'loading'

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPending('rejected')}
          disabled={busy}
          className="text-sm px-4 py-2.5 rounded-lg text-neutral-500 hover:text-neutral-800 transition-colors disabled:opacity-50"
        >
          {labels.decline}
        </button>
        <button
          type="button"
          onClick={() => setPending('accepted')}
          disabled={busy}
          className="flex items-center gap-2 bg-neutral-900 text-white text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-neutral-700 transition-colors disabled:opacity-50"
        >
          {busy
            ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            : <CheckCircle size={14} aria-hidden="true" />}
          {labels.accept}
        </button>
      </div>
      {failed && <p className="text-sm text-red-600" role="alert">{labels.failed}</p>}
      <ConfirmDialog
        open={pending !== null}
        title={pending === 'accepted' ? labels.confirmAccept : labels.confirmDecline}
        description={pending === 'accepted' ? labels.acceptHint : labels.declineHint}
        confirmLabel={pending === 'accepted' ? labels.accept : labels.decline}
        cancelLabel={labels.cancel}
        destructive={pending === 'rejected'}
        busy={busy}
        portal={false}
        onConfirm={() => { if (pending) void respond(pending) }}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}
