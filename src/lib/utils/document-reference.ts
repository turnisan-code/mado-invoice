import type { SupabaseClient } from '@supabase/supabase-js'

export type DocReference = { number: string; date: string }

// Only a credit note that explicitly cancels an issued invoice is a Storno and shows the
// original's number and date. converted_from_id alone is just provenance (quote → invoice,
// plain credit note from an invoice) and must never be rendered as a cancellation.
export async function fetchReference(
  supabase: SupabaseClient,
  doc: { type: string; cancels_document_id?: string | null },
): Promise<DocReference | null> {
  if (doc.type !== 'credit_note' || !doc.cancels_document_id) return null
  const { data } = await supabase.from('documents').select('number, date, type').eq('id', doc.cancels_document_id).maybeSingle()
  return data?.number && data.type === 'invoice' ? { number: data.number, date: data.date } : null
}
