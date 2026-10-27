'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ReceiptText } from 'lucide-react'

export default function ConvertToCreditNoteButton({ invoiceId }: { invoiceId: string }) {
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const router = useRouter()

  async function convert() {
    setLoading(true)
    const res = await fetch(`/api/invoices/${invoiceId}/convert-to-credit-note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error); setLoading(false); setConfirming(false); return }
    toast.success('Credit note created.')
    router.push(`/credit-notes/${data.creditNoteId}`)
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)} disabled={loading} className="flex items-center gap-1.5">
        <ReceiptText size={14} />
        <span className="sr-only sm:not-sr-only">{loading ? 'Creating…' : 'Credit Note'}</span>
      </Button>
      <ConfirmDialog
        open={confirming}
        title="Create a credit note from this invoice?"
        description="A draft credit note with the same line items will be created. The invoice stays as it is — to cancel it, set its status to cancelled instead."
        confirmLabel={loading ? 'Creating…' : 'Create credit note'}
        busy={loading}
        onConfirm={convert}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}
