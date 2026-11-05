'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useT } from '@/lib/i18n/client'
import { lifecycleErrorMessage } from '@/lib/status'

interface Props {
  id: string
  backTo: string
  docNumber: string | null
  docType: string
  /** The document is the template of a recurring schedule, which goes with it. */
  isTemplate?: boolean
}

// Issued (numbered) documents are never deleted — they have to be kept for seven years
// and their number must stay unique. They are cancelled instead; only drafts can go. The delete
// itself only matches unnumbered rows and documents_delete_guard refuses numbered ones, so a
// stale page cannot delete a document that was issued in another tab.
export default function DeleteDocumentButton({ id, backTo, docNumber, isTemplate = false }: Props) {
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const router = useRouter()
  const supabase = createClient()
  const { t } = useT()

  if (docNumber) return null

  async function handleDelete() {
    setLoading(true)
    const { data, error } = await supabase.from('documents').delete().eq('id', id).is('number', null).select('id')
    if (error || !data?.length) {
      toast.error(error ? lifecycleErrorMessage(error, t) : t('lifecycle.errors.issuedNoDelete'))
      setLoading(false)
      setConfirming(false)
      if (!error) router.refresh()
      return
    }
    toast.success(t('documents.draftDeleted'))
    router.push(backTo)
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setConfirming(true)}
        disabled={loading}
        className="ml-auto text-neutral-500 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
      >
        <Trash2 size={14} />
        <span className="sr-only sm:not-sr-only">{loading ? t('common.deleting') : t('common.delete')}</span>
      </Button>
      <ConfirmDialog
        open={confirming}
        title={t('documents.deleteDraftTitle')}
        description={isTemplate ? `${t('documents.cannotUndo')} ${t('recurring.deleteRemovesSchedule')}` : t('documents.cannotUndo')}
        confirmLabel={loading ? t('common.deleting') : t('common.delete')}
        destructive
        busy={loading}
        onConfirm={handleDelete}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}
