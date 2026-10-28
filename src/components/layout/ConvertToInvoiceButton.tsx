'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ArrowRight } from 'lucide-react'
import { useT } from '@/lib/i18n/client'

export default function ConvertToInvoiceButton({ quoteId }: { quoteId: string }) {
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const router = useRouter()
  const { t } = useT()

  async function convert() {
    setLoading(true)
    const res = await fetch(`/quotes/${quoteId}/convert`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error); setLoading(false); setConfirming(false); return }
    toast.success(t('documents.invoiceCreated'))
    router.push(`/invoices/${data.invoiceId}`)
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)} disabled={loading} className="flex items-center gap-1.5">
        <ArrowRight size={14} />
        <span className="sr-only sm:not-sr-only">{loading ? t('documents.converting') : t('documents.convertToInvoice')}</span>
      </Button>
      <ConfirmDialog
        open={confirming}
        title={t('documents.convertTitle')}
        description={t('documents.convertDesc')}
        confirmLabel={loading ? t('documents.converting') : t('documents.convert')}
        busy={loading}
        onConfirm={convert}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}
