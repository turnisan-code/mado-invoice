'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useT } from '@/lib/i18n/client'
import { dbErrorMessage } from '@/lib/api-errors'
import {
  deductionItems, deductionParts, discountOf, linkDeposit, loadClientDeposits, loadQuoteInvoices, sameDeductions,
  unlinkDeposit, type DepositCheck, type DepositInvoice, type QuoteInvoice,
} from '@/lib/deposits'
import { asDbError } from '@/lib/status'
import { lineAmount } from '@/lib/utils/document'
import type { DocumentType, InvoiceKind } from '@/types'
import { makeId, type EditorDocument, type FormState, type LineItem } from './model'

const amountsKey = (lines: readonly LineItem[]) =>
  lines.filter(l => l.line_type === 'deduction').map(l => `${l.vat_rate}|${lineAmount(l)}`).sort().join(',')

// The advance and partial invoices an invoice deducts or could deduct (the client's issued ones),
// and the other invoices made from the quote it came from. A draft final invoice keeps its deduction lines in step with them; an issued one keeps the
// deduction it was issued with. `setKind` changes the kind in the form at once (the snapshot the
// next save writes included).
export function useDeposits({ type, doc, docId, form, setLines, setKind, flush }: {
  type: DocumentType
  doc?: EditorDocument
  docId: string | null
  form: FormState
  setLines: (fn: (lines: LineItem[]) => LineItem[]) => void
  setKind: (kind: InvoiceKind) => void
  flush: () => Promise<void>
}) {
  const supabase = createClient()
  const { t } = useT()
  const enabled = type === 'invoice'
  const issued = !!doc?.number
  const [loaded, setLoaded] = useState<{ clientId: string; invoices: DepositInvoice[]; fromQuote: QuoteInvoice[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)

  const clientId = form.clientId
  const sourceId = doc?.converted_from_id ?? null
  useEffect(() => {
    if (!enabled || !clientId) return
    let current = true
    const supabase = createClient()
    Promise.all([loadClientDeposits(supabase, clientId), docId ? loadQuoteInvoices(supabase, sourceId, docId) : []])
      .then(([list, fromQuote]) => { if (current) setLoaded({ clientId, invoices: list, fromQuote }) })
      .catch(e => {
        if (!current) return
        console.error('[deposits] not loaded:', e)
        toast.error(t('deposits.builder.loadFailed'), { description: dbErrorMessage(t, asDbError(e)) })
        setLoaded({ clientId, invoices: [], fromQuote: [] })
      })
    return () => { current = false }
  }, [enabled, clientId, sourceId, docId, t, version])

  const invoices = useMemo(() => (loaded && loaded.clientId === clientId ? loaded.invoices : null), [loaded, clientId])
  const linked = useMemo(
    () => (invoices && docId && form.invoiceKind === 'final' ? invoices.filter(d => d.final_invoice_id === docId) : []),
    [invoices, docId, form.invoiceKind],
  )
  const expected = useMemo(() => deductionItems(deductionParts(linked), form.language), [linked, form.language])

  // Draft invoices follow what they deduct now: payments received on an advance invoice since,
  // a changed language, a copied final invoice that deducts nothing.
  const lines = form.lines
  useEffect(() => {
    if (!enabled || issued || invoices === null || sameDeductions(lines, expected)) return
    const next = expected.map((item): LineItem => ({
      id: makeId(), line_type: 'deduction', description: item.description, service_date: null, service_date_end: null,
      quantity: item.quantity, unit: item.unit, unit_price: item.unit_price, vat_rate: item.vat_rate,
      catalogue_item_id: null, discount_type: null, discount_value: 0,
    }))
    if (amountsKey(lines) !== amountsKey(next)) toast.info(t('deposits.builder.synced'))
    setLines(ls => [...ls.filter(l => l.line_type !== 'deduction'), ...next])
  }, [enabled, issued, invoices, lines, expected, setLines, t])

  // Writes pending edits, then changes the links. `kind` goes into the form before that write, so
  // no save can put the old kind back over the one the link sets (the database refuses a final
  // invoice that deducts something turning into another kind); it is restored when nothing changed.
  async function change(action: () => Promise<boolean>, kind?: InvoiceKind) {
    if (!docId) return
    const before = form.invoiceKind
    let done = false
    setBusy(true)
    try {
      if (kind) setKind(kind)
      await flush()
      done = await action()
      setVersion(v => v + 1)
    } catch (e) {
      console.error('[deposits] link not changed:', e)
      toast.error(t('deposits.builder.failed'), { description: dbErrorMessage(t, asDbError(e)) })
    } finally {
      if (kind && !done && before !== kind) setKind(before)
      setBusy(false)
    }
  }

  // Deducting an invoice makes this one the final invoice.
  const link = (d: DepositInvoice) => change(async () => {
    const result = await linkDeposit(supabase, docId!, d.id)
    if (result === 'taken') {
      toast.error(t('deposits.builder.taken', { number: d.number ?? '' }))
      return false
    }
    toast.success(t('deposits.builder.linked', { number: d.number ?? '' }))
    return true
  }, 'final')

  const unlink = (d: DepositInvoice) => change(async () => {
    await unlinkDeposit(supabase, docId!, d.id)
    toast.success(t('deposits.builder.removed', { number: d.number ?? '' }))
    return true
  })

  const check: DepositCheck | undefined = enabled
    ? {
        kind: form.invoiceKind, documentId: docId, language: form.language,
        discount: discountOf({ discount_type: form.discountType, discount_value: form.discountValue }),
        invoices: invoices ?? [], fromQuote: loaded?.fromQuote ?? [],
      }
    : undefined

  return {
    enabled,
    invoices,
    linked,
    // What this draft could still deduct: issued invoices no final invoice deducts yet.
    free: invoices && docId && !issued ? invoices.filter(d => !d.final_invoice_id && d.id !== docId) : [],
    // This invoice as a deducted one: the final invoice that deducts it.
    self: invoices?.find(d => d.id === docId) ?? null,
    busy,
    link,
    unlink,
    check,
  }
}
