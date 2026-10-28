import type { SupabaseClient } from '@supabase/supabase-js'
import type { DocumentEventType } from '@/types'

// The history records what happened; a failed write is reported in the log and never fails
// (or throws into) the action it describes.
export async function logEvent(
  supabase: SupabaseClient,
  documentId: string,
  type: DocumentEventType,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { error } = await supabase.from('document_events').insert({ document_id: documentId, type, detail })
    if (error) console.error(`[events] ${type} not recorded for ${documentId}:`, error.message)
  } catch (err) {
    console.error(`[events] ${type} not recorded for ${documentId}:`, err)
  }
}
