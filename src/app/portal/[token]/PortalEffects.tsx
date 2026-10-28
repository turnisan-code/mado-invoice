'use client'

import { useEffect, useRef } from 'react'
import type { Language } from '@/types'

// <html lang> comes from the root layout (the owner's UI language, 'en' for anonymous visitors);
// the portal speaks the document's language. viewToken reports one client view per page load.
export default function PortalEffects({ lang, viewToken }: { lang: Language; viewToken?: string }) {
  const reported = useRef(false)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  useEffect(() => {
    if (!viewToken || reported.current) return
    reported.current = true
    void fetch(`/api/portal/${viewToken}/viewed`, { method: 'POST', keepalive: true }).catch(() => {})
  }, [viewToken])

  return null
}
