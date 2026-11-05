import { cache } from 'react'
import { createServiceClient } from '@/lib/supabase/service'
import { documentLanguage } from '@/lib/document-labels'
import type { Language } from '@/types'

// The shared document's language for the portal's not-found and error pages; null when the token
// matches no issued document or the lookup fails, and those pages then speak German and English.
export const sharedDocumentLanguage = cache(async (token: string): Promise<Language | null> => {
  try {
    const { data } = await createServiceClient()
      .from('documents')
      .select('language, number')
      .eq('share_token', token)
      .maybeSingle()
    return data?.number ? documentLanguage(data.language) : null
  } catch {
    return null
  }
})
