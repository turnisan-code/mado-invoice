import type { SupabaseClient } from '@supabase/supabase-js'

export type DocReference = { number: string; date: string }

// A credit note created from an invoice is a Storno: the original's number and date
// must appear on the document (number-less drafts cannot be referenced).
export async function fetchReference(supabase: SupabaseClient, convertedFromId: string | null | undefined): Promise<DocReference | null> {
  if (!convertedFromId) return null
  const { data } = await supabase.from('documents').select('number, date').eq('id', convertedFromId).maybeSingle()
  return data?.number ? { number: data.number, date: data.date } : null
}
