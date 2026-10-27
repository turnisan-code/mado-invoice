'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useT } from '@/lib/i18n/client'

interface Props {
  id: string
  backTo: string
  docNumber: string | null
  docType: string
}

// Issued (numbered) documents are never deleted — they have to be kept for seven years
// and their number must stay unique. They are cancelled instead; only drafts can go.
export default function DeleteDocumentButton({ id, backTo, docNumber }: Props) {
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const router = useRouter()
  const supabase = createClient()
  const { t } = useT()

  if (docNumber) return null

  async function handleDelete() {
    setLoading(true)
    const { error } = await supabase.from('documents').delete().eq('id', id)
    if (error) { toast.error(error.message); setLoading(false); setConfirming(false); return }
    toast.success(t('documents.draftDeleted'))
    router.push(backTo)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={loading}
        className="flex items-center gap-1.5 text-sm px-2.5 py-2 sm:py-1 rounded-md text-neutral-500 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors ml-auto disabled:opacity-50"
      >
        <Trash2 size={14} />
        <span className="sr-only sm:not-sr-only">{loading ? t('common.deleting') : t('common.delete')}</span>
      </button>
      <ConfirmDialog
        open={confirming}
        title={t('documents.deleteDraftTitle')}
        description={t('documents.cannotUndo')}
        confirmLabel={loading ? t('common.deleting') : t('common.delete')}
        destructive
        busy={loading}
        onConfirm={handleDelete}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}
