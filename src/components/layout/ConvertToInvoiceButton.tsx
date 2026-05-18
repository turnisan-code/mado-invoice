'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ArrowRight } from 'lucide-react'

export default function ConvertToInvoiceButton({ quoteId }: { quoteId: string }) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function convert() {
    if (!confirm('Convert this quote to an invoice? The quote will be marked as accepted.')) return
    setLoading(true)
    const res = await fetch(`/quotes/${quoteId}/convert`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error); setLoading(false); return }
    toast.success('Invoice created.')
    router.push(`/invoices/${data.invoiceId}`)
  }

  return (
    <Button variant="outline" size="sm" onClick={convert} disabled={loading} className="flex items-center gap-1.5">
      <ArrowRight size={14} />
      {loading ? 'Converting…' : 'Convert to Invoice'}
    </Button>
  )
}
