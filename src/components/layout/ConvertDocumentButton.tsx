'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowRight, FileCheck, ReceiptText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { flushPendingEdits } from '@/lib/issued-pdf'
import { apiErrorMessage, requestErrorMessage } from '@/lib/api-errors'
import { useT } from '@/lib/i18n/client'

// Quote → invoice, quote → final invoice and invoice → credit note. The server copies the source
// document from the database, so the builder's pending autosave on this page is written first.
const KINDS = {
  invoice: {
    icon: ArrowRight,
    label: 'documents.convertToInvoice',
    title: 'documents.convertTitle',
    description: 'documents.convertDesc',
    confirm: 'documents.convert',
    busy: 'documents.converting',
    done: 'documents.invoiceCreated',
    url: (id: string) => `/quotes/${id}/convert`,
    target: (data: { invoiceId?: string }) => data.invoiceId ? `/invoices/${data.invoiceId}` : null,
  },
  final_invoice: {
    icon: FileCheck,
    label: 'deposits.quote.createFinal',
    title: 'deposits.quote.finalTitle',
    description: 'deposits.quote.finalDesc',
    confirm: 'deposits.quote.createFinalConfirm',
    busy: 'documents.creating',
    done: 'deposits.quote.finalCreated',
    url: (id: string) => `/api/quotes/${id}/final`,
    target: (data: { invoiceId?: string }) => data.invoiceId ? `/invoices/${data.invoiceId}` : null,
  },
  credit_note: {
    icon: ReceiptText,
    label: 'documents.creditNote',
    title: 'documents.createCreditNoteTitle',
    description: 'documents.createCreditNoteDesc',
    confirm: 'documents.createCreditNote',
    busy: 'documents.creating',
    done: 'documents.creditNoteCreated',
    url: (id: string) => `/api/invoices/${id}/convert-to-credit-note`,
    target: (data: { creditNoteId?: string }) => data.creditNoteId ? `/credit-notes/${data.creditNoteId}` : null,
  },
} as const

export default function ConvertDocumentButton({ kind, sourceId }: { kind: keyof typeof KINDS; sourceId: string }) {
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const router = useRouter()
  const { t } = useT()
  const k = KINDS[kind]
  const Icon = k.icon

  async function convert() {
    if (loading) return
    setLoading(true)
    try {
      await flushPendingEdits(sourceId)
      const res = await fetch(k.url(sourceId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const data = await res.json().catch(() => ({}))
      const href = res.ok ? k.target(data) : null
      if (!href) { toast.error(apiErrorMessage(t, data)); return }
      toast.success(data.existing ? t('lifecycle.convert.alreadyConverted') : t(k.done))
      router.push(href)
    } catch (err) {
      toast.error(requestErrorMessage(t, err))
    } finally {
      setLoading(false)
      setConfirming(false)
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)} disabled={loading} className="flex items-center gap-1.5">
        <Icon size={14} />
        <span className="sr-only sm:not-sr-only">{loading ? t(k.busy) : t(k.label)}</span>
      </Button>
      <ConfirmDialog
        open={confirming}
        title={t(k.title)}
        description={t(k.description)}
        confirmLabel={loading ? t(k.busy) : t(k.confirm)}
        busy={loading}
        onConfirm={() => void convert()}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}
