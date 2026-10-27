'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ReceiptText } from 'lucide-react'
import { useT } from '@/lib/i18n/client'

export default function ConvertToCreditNoteButton({ invoiceId }: { invoiceId: string }) {
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const router = useRouter()
  const { t } = useT()

  async function convert() {
    setLoading(true)
    const res = await fetch(`/api/invoices/${invoiceId}/convert-to-credit-note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error); setLoading(false); setConfirming(false); return }
    toast.success(t('documents.creditNoteCreated'))
    router.push(`/credit-notes/${data.creditNoteId}`)
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)} disabled={loading} className="flex items-center gap-1.5">
        <ReceiptText size={14} />
        <span className="sr-only sm:not-sr-only">{loading ? t('documents.creating') : t('documents.creditNote')}</span>
      </Button>
      <ConfirmDialog
        open={confirming}
        title={t('documents.createCreditNoteTitle')}
        description={t('documents.createCreditNoteDesc')}
        confirmLabel={loading ? t('documents.creating') : t('documents.createCreditNote')}
        busy={loading}
        onConfirm={convert}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}
