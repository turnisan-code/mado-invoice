'use client'

import { useState } from 'react'
import { CheckCircle, XCircle, Loader2 } from 'lucide-react'

const L: Record<string, { de: string; en: string }> = {
  accept:          { de: 'Angebot annehmen',                          en: 'Accept quote' },
  decline:         { de: 'Ablehnen',                                  en: 'Decline' },
  accepted_msg:    { de: 'Angebot angenommen — wir melden uns bald!', en: 'Quote accepted — we\'ll be in touch!' },
  declined_msg:    { de: 'Angebot abgelehnt.',                        en: 'Quote declined.' },
  confirm_accept:  { de: 'Angebot annehmen?',                        en: 'Accept this quote?' },
  confirm_decline: { de: 'Angebot ablehnen?',                        en: 'Decline this quote?' },
}

function t(key: string, lang: 'de' | 'en') { return L[key]?.[lang] ?? key }

export default function QuoteActions({ token, lang }: { token: string; lang: 'de' | 'en' }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'accepted' | 'rejected'>('idle')

  async function respond(action: 'accepted' | 'rejected') {
    const msg = action === 'accepted' ? t('confirm_accept', lang) : t('confirm_decline', lang)
    if (!confirm(msg)) return
    setStatus('loading')
    const res = await fetch(`/api/portal/${token}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    setStatus(res.ok ? (action === 'accepted' ? 'accepted' : 'rejected') : 'idle')
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
      <div className="flex items-center gap-2 text-neutral-400 text-sm">
        <XCircle size={15} />
        {t('declined_msg', lang)}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => respond('rejected')}
        disabled={status === 'loading'}
        className="text-sm px-4 py-2.5 text-neutral-500 hover:text-neutral-800 transition-colors disabled:opacity-50"
      >
        {t('decline', lang)}
      </button>
      <button
        onClick={() => respond('accepted')}
        disabled={status === 'loading'}
        className="flex items-center gap-2 bg-neutral-900 text-white text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-neutral-700 transition-colors disabled:opacity-50"
      >
        {status === 'loading'
          ? <Loader2 size={14} className="animate-spin" />
          : <CheckCircle size={14} />}
        {t('accept', lang)}
      </button>
    </div>
  )
}
