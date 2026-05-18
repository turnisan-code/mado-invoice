'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'

export default function DeleteDocumentButton({ id, backTo, docNumber, docType }: {
  id: string; backTo: string; docNumber: string; docType: string
}) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  async function handleDelete() {
    if (!confirm('Delete this document? This cannot be undone.')) return
    setLoading(true)

    // Check if this is the most recently created document of its type
    // by comparing its sequence number to the current counter
    const counterField = docType === 'invoice' ? 'next_invoice_number'
      : docType === 'quote' ? 'next_quote_number'
      : 'next_credit_note_number'

    const { data: settings } = await supabase.from('settings').select(`id, ${counterField}`).single() as { data: Record<string, unknown> | null }
    const currentCounter = settings?.[counterField] as number | undefined

    // Parse sequence from number like "RN-202605011" → 11
    const seqMatch = docNumber.match(/(\d{3})$/)
    const seqNum = seqMatch ? parseInt(seqMatch[1], 10) : null

    const { error } = await supabase.from('documents').delete().eq('id', id)
    if (error) { toast.error(error.message); setLoading(false); return }

    // Only offer counter restore if this was the last issued document
    if (currentCounter !== undefined && seqNum !== null && seqNum === currentCounter - 1) {
      const restore = confirm(
        `Restore the ${docType} counter from ${currentCounter} back to ${seqNum} to avoid a gap in numbering?`
      )
      if (restore) {
        await supabase.from('settings').update({ [counterField]: seqNum }).eq('id', settings!.id)
        toast.success('Deleted and counter restored.')
      } else {
        toast.success('Deleted. Gap left in numbering.')
      }
    } else {
      toast.success('Deleted.')
    }

    router.push(backTo)
  }

  return (
    <button
      onClick={handleDelete}
      disabled={loading}
      className="flex items-center gap-1.5 text-sm px-2.5 py-1 rounded-md text-neutral-400 hover:text-red-600 hover:bg-red-50 transition-colors ml-auto"
    >
      <Trash2 size={14} />
      {loading ? 'Deleting…' : 'Delete'}
    </button>
  )
}
