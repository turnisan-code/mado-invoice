'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'

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
  const router = useRouter()
  const supabase = createClient()

  if (docNumber) return null

  async function handleDelete() {
    if (!confirm('Delete this draft? This cannot be undone.')) return
    setLoading(true)
    const { error } = await supabase.from('documents').delete().eq('id', id)
    if (error) { toast.error(error.message); setLoading(false); return }
    toast.success('Draft deleted.')
    router.push(backTo)
  }

  return (
    <button
      onClick={handleDelete}
      disabled={loading}
      className="flex items-center gap-1.5 text-sm px-2.5 py-1 rounded-md text-neutral-400 hover:text-red-600 hover:bg-red-50 transition-colors ml-auto"
    >
      <Trash2 size={14} />
      <span className="hidden sm:inline">{loading ? 'Deleting…' : 'Delete'}</span>
    </button>
  )
}
