import type { SupabaseClient } from '@supabase/supabase-js'

// kind 'correction' is a plain credit note that corrects the invoice it was created from;
// without a kind the reference is a Storno's.
export type DocReference = { number: string; date: string; kind?: 'storno' | 'correction' }

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

// What a credit note prints about its invoice: the Storno reference, otherwise the issued
// invoice it was created from, as a correction (Rechnungskorrektur).
export async function fetchCreditReference(
  supabase: SupabaseClient,
  doc: { type: string; cancels_document_id?: string | null; converted_from_id?: string | null },
): Promise<DocReference | null> {
  if (doc.type !== 'credit_note') return null
  const storno = await fetchReference(supabase, doc)
  if (storno) return { ...storno, kind: 'storno' }
  if (!doc.converted_from_id) return null
  const { data } = await supabase.from('documents').select('number, date, type').eq('id', doc.converted_from_id).maybeSingle()
  return data?.number && data.type === 'invoice' ? { number: data.number, date: data.date, kind: 'correction' } : null
}

// The buyer reference a document prints, resolved as its e-invoice resolves it
// (src/lib/einvoice/export.ts): its own once set ('' = cleared on purpose); while never set, that
// of the invoice a credit note corrects, else the client's default.
export async function fetchBuyerReference(
  supabase: SupabaseClient,
  doc: { type: string; buyer_reference?: string | null; cancels_document_id?: string | null; converted_from_id?: string | null },
  client: { buyer_reference?: string | null } | null | undefined,
): Promise<string | null> {
  if (doc.buyer_reference != null) return doc.buyer_reference.trim() || null
  const sourceId = doc.type === 'credit_note' ? doc.cancels_document_id ?? doc.converted_from_id : null
  if (sourceId) {
    const { data } = await supabase.from('documents').select('buyer_reference').eq('id', sourceId).maybeSingle()
    const source = (data?.buyer_reference as string | null | undefined)?.trim()
    if (source) return source
  }
  return client?.buyer_reference?.trim() || null
}
