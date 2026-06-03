'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ReceiptText } from 'lucide-react'

export default function ConvertToCreditNoteButton({ invoiceId }: { invoiceId: string }) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function convert() {
    if (!confirm('Create a credit note from this invoice? A draft credit note with the same line items will be created.')) return
    setLoading(true)
    const res = await fetch(`/api/invoices/${invoiceId}/convert-to-credit-note`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error); setLoading(false); return }
    toast.success('Credit note created.')
    router.push(`/credit-notes/${data.creditNoteId}`)
  }

  return (
    <Button variant="outline" size="sm" onClick={convert} disabled={loading} className="flex items-center gap-1.5">
      <ReceiptText size={14} />
      <span className="hidden sm:inline">{loading ? 'Creating…' : 'Credit Note'}</span>
    </Button>
  )
}
