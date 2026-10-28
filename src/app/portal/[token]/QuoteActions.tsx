'use client'

import { useState } from 'react'
import { CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { makeT } from '@/lib/i18n'

const L: Record<string, { de: string; en: string }> = {
  accept:          { de: 'Angebot annehmen',                          en: 'Accept quote' },
  decline:         { de: 'Ablehnen',                                  en: 'Decline' },
  cancel:          { de: 'Abbrechen',                                 en: 'Cancel' },
  accepted_msg:    { de: 'Angebot angenommen — wir melden uns bald!', en: 'Quote accepted — we\'ll be in touch!' },
  declined_msg:    { de: 'Angebot abgelehnt.',                        en: 'Quote declined.' },
  confirm_accept:  { de: 'Angebot annehmen?',                        en: 'Accept this quote?' },
  confirm_decline: { de: 'Angebot ablehnen?',                        en: 'Decline this quote?' },
  accept_hint:     { de: 'Wir werden über Ihre Zusage informiert.',   en: 'We will be notified of your acceptance.' },
  decline_hint:    { de: 'Wir werden über Ihre Absage informiert.',   en: 'We will be notified that you declined.' },
}

function t(key: string, lang: 'de' | 'en') { return L[key]?.[lang] ?? key }

export default function QuoteActions({ token, lang }: { token: string; lang: 'de' | 'en' }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'accepted' | 'rejected'>('idle')
  const [pending, setPending] = useState<'accepted' | 'rejected' | null>(null)
  const [error, setError] = useState<{ message: string; final: boolean } | null>(null)

  async function respond(action: 'accepted' | 'rejected') {
    setStatus('loading')
    setError(null)
    try {
      const res = await fetch(`/api/portal/${token}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (res.ok) { setStatus(action); return }
      // The quote expired while the page was open: the server's message names the date.
      const data = await res.json().catch(() => ({}))
      const expired = data.code === 'expired' && typeof data.error === 'string'
      const docT = makeT(lang)
      setError({ message: expired ? `${data.error} ${docT('lifecycle.portal.expiredHint')}` : docT('lifecycle.portal.respondFailed'), final: expired })
      setStatus('idle')
    } catch {
      setError({ message: makeT(lang)('lifecycle.portal.respondFailed'), final: false })
      setStatus('idle')
    } finally {
      setPending(null)
    }
  }

  if (status === 'accepted') {
    return (
      <div className="flex items-center gap-2 text-green-700 text-sm font-medium">
        <CheckCircle size={15} />
        {t('accepted_msg', lang)}
      </div>
    )
  }

  if (status === 'rejected') {
    return (
      <div className="flex items-center gap-2 text-neutral-500 text-sm">
        <XCircle size={15} />
        {t('declined_msg', lang)}
      </div>
    )
  }

  const busy = status === 'loading'

  if (error?.final) return <p role="alert" className="text-sm text-neutral-600">{error.message}</p>

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {error && <p role="alert" className="w-full text-sm text-red-600">{error.message}</p>}
      <button
        type="button"
        onClick={() => setPending('rejected')}
        disabled={busy}
        className="text-sm px-4 py-2.5 rounded-lg text-neutral-500 hover:text-neutral-800 transition-colors disabled:opacity-50"
      >
        {t('decline', lang)}
      </button>
      <button
        type="button"
        onClick={() => setPending('accepted')}
        disabled={busy}
        className="flex items-center gap-2 bg-neutral-900 text-white text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-neutral-700 transition-colors disabled:opacity-50"
      >
        {busy
          ? <Loader2 size={14} className="animate-spin" />
          : <CheckCircle size={14} />}
        {t('accept', lang)}
      </button>
      <ConfirmDialog
        open={pending !== null}
        title={pending === 'accepted' ? t('confirm_accept', lang) : t('confirm_decline', lang)}
        description={pending === 'accepted' ? t('accept_hint', lang) : t('decline_hint', lang)}
        confirmLabel={pending === 'accepted' ? t('accept', lang) : t('decline', lang)}
        cancelLabel={t('cancel', lang)}
        destructive={pending === 'rejected'}
        busy={busy}
        portal={false}
        onConfirm={() => { if (pending) void respond(pending) }}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}
