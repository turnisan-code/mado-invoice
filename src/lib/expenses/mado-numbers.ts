// The documents Mado issued, by number (PR 9a). A statement line naming one is that document's
// money — an invoice's payment is recorded in the „Einnahmen“ tab, a credit note's refund on the
// credit note — and is never booked here as an expense or another credit (as Bookmatic never
// booked a Mado credit). The „Einnahmen“ tab's matcher finds most; this catches the rest.
import type { SupabaseClient } from '@supabase/supabase-js'
import { BookamatError } from '@/lib/bookamat'
import type { EasybankTransaction } from './types'

export type MadoNumber = { type: 'invoice' | 'credit_note'; number: string }

const PAGE = 1000
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export async function readMadoNumbers(supabase: SupabaseClient): Promise<MadoNumber[]> {
  const out: MadoNumber[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('documents').select('type, number').in('type', ['invoice', 'credit_note'])
      .not('number', 'is', null).order('id').range(from, from + PAGE - 1)
    if (error) throw new BookamatError('database', error.message)
    for (const d of (data ?? []) as { type: MadoNumber['type']; number: string | null }[]) {
      // Only a number long enough to be told apart from anything else in a bank text
      if (d.number && d.number.replace(/\D/g, '').length >= 5) out.push({ type: d.type, number: d.number })
    }
    if ((data ?? []).length < PAGE) break
  }
  return out
}

// The Mado document a line's bank text names whole (easybank's line breaks removed, any case),
// not as part of a longer number; null for none
export function namedDocument(tx: Pick<EasybankTransaction, 'raw' | 'reference'>, numbers: readonly MadoNumber[]): MadoNumber | null {
  const text = (tx.raw?.col1 ?? tx.reference ?? '').replace(/\|/g, '').toUpperCase()
  return numbers.find(d => new RegExp(`(?<![0-9])${escapeRe(d.number.toUpperCase())}(?![0-9])`).test(text)) ?? null
}

export const madoDocumentText = (d: MadoNumber, credit: boolean): string =>
  credit
    ? `Nennt ${d.number} aus Mado — als Zahlung im Tab „Einnahmen“ erfassen, hier nicht buchen`
    : d.type === 'credit_note'
      ? `Nennt ${d.number} aus Mado — Rückzahlung an der Gutschrift in Mado erfassen, hier nicht buchen`
      : `Nennt ${d.number} aus Mado — dort erfassen, hier nicht buchen`
