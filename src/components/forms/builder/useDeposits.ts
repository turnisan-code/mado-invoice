'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useT } from '@/lib/i18n/client'
import {
  deductionItems, deductionParts, discountOf, linkDeposit, loadClientDeposits, sameDeductions, unlinkDeposit,
  type DepositCheck, type DepositInvoice,
} from '@/lib/deposits'
import { lineAmount } from '@/lib/utils/document'
import type { DocumentType } from '@/types'
import { makeId, type EditorDocument, type FormState, type LineItem } from './model'

const amountsKey = (lines: readonly LineItem[]) =>
  lines.filter(l => l.line_type === 'deduction').map(l => `${l.vat_rate}|${lineAmount(l)}`).sort().join(',')

// The advance and partial invoices an invoice deducts or could deduct (the client's issued ones).
// A draft final invoice keeps its deduction lines in step with them; an issued one keeps the
// deduction it was issued with.
export function useDeposits({ type, doc, docId, form, setLines, flush }: {
  type: DocumentType
  doc?: EditorDocument
  docId: string | null
  form: FormState
  setLines: (fn: (lines: LineItem[]) => LineItem[]) => void
  flush: () => Promise<void>
}) {
  const supabase = createClient()
  const { t } = useT()
  const enabled = type === 'invoice'
  const issued = !!doc?.number
  const [loaded, setLoaded] = useState<{ clientId: string; invoices: DepositInvoice[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)

  const clientId = form.clientId
  useEffect(() => {
    if (!enabled || !clientId) return
    let current = true
    loadClientDeposits(createClient(), clientId)
      .then(list => { if (current) setLoaded({ clientId, invoices: list }) })
      .catch(e => {
        if (!current) return
        toast.error(t('deposits.builder.loadFailed', { error: e instanceof Error ? e.message : String(e) }))
        setLoaded({ clientId, invoices: [] })
      })
    return () => { current = false }
  }, [enabled, clientId, t, version])

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

  async function change(action: () => Promise<void>) {
    if (!docId) return
    setBusy(true)
    try {
      await flush()
      await action()
      setVersion(v => v + 1)
    } catch (e) {
      toast.error(t('deposits.builder.failed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  const link = (d: DepositInvoice) => change(async () => {
    const result = await linkDeposit(supabase, docId!, d.id)
    if (result === 'taken') toast.error(t('deposits.builder.taken', { number: d.number ?? '' }))
    else toast.success(t('deposits.builder.linked', { number: d.number ?? '' }))
  })

  const unlink = (d: DepositInvoice) => change(async () => {
    await unlinkDeposit(supabase, docId!, d.id)
    toast.success(t('deposits.builder.removed', { number: d.number ?? '' }))
  })

  const check: DepositCheck | undefined = enabled
    ? { kind: form.invoiceKind, documentId: docId, language: form.language, discount: discountOf({ discount_type: form.discountType, discount_value: form.discountValue }), invoices: invoices ?? [] }
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
