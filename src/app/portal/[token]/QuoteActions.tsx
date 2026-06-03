'use client'

import { useState } from 'react'
import { CheckCircle, XCircle, Loader2 } from 'lucide-react'

const L: Record<string, { de: string; en: string }> = {
  accept:         { de: 'Angebot annehmen',  en: 'Accept quote' },
  decline:        { de: 'Ablehnen',           en: 'Decline' },
  accepted_msg:   { de: 'Angebot angenommen. Wir melden uns bei Ihnen!', en: 'Quote accepted. We\'ll be in touch!' },
  declined_msg:   { de: 'Angebot abgelehnt.', en: 'Quote declined.' },
  confirm_accept: { de: 'Angebot annehmen?',  en: 'Accept this quote?' },
  confirm_decline:{ de: 'Angebot ablehnen?',  en: 'Decline this quote?' },
}

function t(key: string, lang: 'de' | 'en') { return L[key]?.[lang] ?? key }

export default function QuoteActions({ token, lang }: { token: string; lang: 'de' | 'en' }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'accepted' | 'rejected'>('idle')

  async function respond(action: 'accepted' | 'rejected') {
    const confirmMsg = action === 'accepted' ? t('confirm_accept', lang) : t('confirm_decline', lang)
    if (!confirm(confirmMsg)) return
    setStatus('loading')
    const res = await fetch(`/api/portal/${token}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (res.ok) {
      setStatus(action === 'accepted' ? 'accepted' : 'rejected')
    } else {
      setStatus('idle')
    }
  }

  if (status === 'accepted') {
    return (
      <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm font-medium">
        <CheckCircle size={16} />
        {t('accepted_msg', lang)}
      </div>
    )
  }

  if (status === 'rejected') {
    return (
      <div className="flex items-center gap-2 text-neutral-500 bg-neutral-50 border border-neutral-200 rounded-xl px-4 py-3 text-sm">
        <XCircle size={16} />
        {t('declined_msg', lang)}
      </div>
    )
  }

  return (
    <div className="flex gap-3">
      <button
        onClick={() => respond('accepted')}
        disabled={status === 'loading'}
        className="flex-1 flex items-center justify-center gap-2 bg-neutral-900 text-white text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-neutral-700 transition-colors disabled:opacity-50"
      >
        {status === 'loading' ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
        {t('accept', lang)}
      </button>
      <button
        onClick={() => respond('rejected')}
        disabled={status === 'loading'}
        className="flex items-center justify-center gap-2 border border-neutral-200 text-neutral-600 text-sm px-4 py-2.5 rounded-lg hover:bg-neutral-50 transition-colors disabled:opacity-50"
      >
        <XCircle size={15} />
        {t('decline', lang)}
      </button>
    </div>
  )
}
