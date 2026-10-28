'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

// Opening the quote clears its "client responded" notice on the dashboard. Done from the browser,
// so a prefetch of this page never marks anything as read.
export default function MarkResponsesRead({ documentId }: { documentId: string }) {
  useEffect(() => {
    void createClient()
      .from('document_events')
      .update({ read_at: new Date().toISOString() })
      .eq('document_id', documentId)
      .eq('type', 'portal_responded')
      .is('read_at', null)
      .then(({ error }) => { if (error) console.error('[responses] not marked as read:', error.message) })
  }, [documentId])
  return null
}
