'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Copy } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { duplicateDocument } from '@/lib/services/drafts'
import { useT } from '@/lib/i18n/client'

interface Props {
  docId: string
  docType: string
  backTo: string
}

export default function DuplicateDocumentButton({ docId, backTo }: Props) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()
  const { t } = useT()

  async function duplicate() {
    setLoading(true)
    const copy = await duplicateDocument(supabase, docId)
    if (copy.error) {
      toast.error(t(copy.error.stage === 'load' ? 'documents.couldNotLoad' : 'documents.couldNotDuplicate'))
      setLoading(false)
      return
    }
    toast.success(t('documents.duplicated'))
    router.push(`${backTo}/${copy.id}`)
  }

  return (
    <Button type="button" variant="outline" onClick={duplicate} disabled={loading} title={t('documents.duplicateTitle')}>
      <Copy size={14} /> <span className="sr-only sm:not-sr-only">{loading ? t('documents.duplicating') : t('documents.duplicate')}</span>
    </Button>
  )
}
