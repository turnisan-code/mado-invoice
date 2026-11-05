'use client'

import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { PortalNotice } from './PortalLanguage'

// The client's view of a failure: no app links, no technical detail, a way to try again.
export default function PortalError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => { console.error(error) }, [error])
  return (
    <PortalNotice
      icon={<AlertTriangle size={28} className="mx-auto text-neutral-400" aria-hidden="true" />}
      title="messages.portal.errorTitle"
      body="messages.portal.errorBody"
      retry={unstable_retry}
    />
  )
}
