'use client'

import { useState } from 'react'
import { CheckCircle, XCircle, Loader2, Info } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { makeT } from '@/lib/i18n'
import type { Language } from '@/types'

type Action = 'accepted' | 'rejected'

// Speaks the quote's language, not the visitor's or the owner's.
export default function QuoteActions({ token, lang }: { token: string; lang: Language }) {
  const t = makeT(lang)
  const [answer, setAnswer] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Action | null>(null)
  const [failed, setFailed] = useState(false)
  // A response no retry can change: the quote expired or was answered, or the link expired.
  const [final, setFinal] = useState<string | null>(null)

  async function respond(action: Action) {
    setBusy(true)
    setFailed(false)
    try {
      const res = await fetch(`/api/portal/${token}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = await res.json().catch(() => ({})) as { error?: unknown; code?: unknown }
      const message = typeof data.error === 'string' && data.error ? data.error : null
      if (res.ok) setAnswer(action)
      else if (res.status === 410 && data.code === 'link_expired') setFinal(t('pdfPortal.portal.expiredTitle'))
      else if (res.status === 409 && data.code === 'expired') setFinal(message ?? t('lifecycle.portal.expiredHint'))
      else if (res.status === 409 && data.code === 'answered') setFinal(message ?? t('lifecycle.portal.answered'))
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  if (answer === 'accepted') {
    return (
      <div className="flex items-center gap-2 text-green-700 text-sm font-medium" role="status">
        <CheckCircle size={15} aria-hidden="true" />
        {t('pdfPortal.portal.quote.accepted')}
      </div>
    )
  }

  if (answer === 'rejected') {
    return (
      <div className="flex items-center gap-2 text-neutral-500 text-sm" role="status">
        <XCircle size={15} aria-hidden="true" />
        {t('pdfPortal.portal.quote.declined')}
      </div>
    )
  }

  if (final) {
    return (
      <div className="flex items-start gap-2 text-neutral-600 text-sm max-w-sm" role="status">
        <Info size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        {final}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPending('rejected')}
          disabled={busy}
          className="text-sm px-4 py-2.5 rounded-lg text-neutral-500 hover:text-neutral-800 transition-colors disabled:opacity-50"
        >
          {t('pdfPortal.portal.quote.decline')}
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
          {t('pdfPortal.portal.quote.accept')}
        </button>
      </div>
      {failed && <p className="text-sm text-red-600" role="alert">{t('pdfPortal.portal.quote.failed')}</p>}
      <ConfirmDialog
        open={pending !== null}
        title={pending === 'accepted' ? t('pdfPortal.portal.quote.confirmAccept') : t('pdfPortal.portal.quote.confirmDecline')}
        description={pending === 'accepted' ? t('pdfPortal.portal.quote.acceptHint') : t('pdfPortal.portal.quote.declineHint')}
        confirmLabel={pending === 'accepted' ? t('pdfPortal.portal.quote.accept') : t('pdfPortal.portal.quote.decline')}
        cancelLabel={t('pdfPortal.portal.quote.cancel')}
        destructive={pending === 'rejected'}
        busy={busy}
        portal={false}
        onConfirm={() => { if (pending) void respond(pending) }}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}
