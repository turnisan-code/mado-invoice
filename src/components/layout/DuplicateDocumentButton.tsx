'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Copy } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { today } from '@/lib/utils/document'

interface Props {
  docId: string
  docType: string
  backTo: string
}

export default function DuplicateDocumentButton({ docId, docType, backTo }: Props) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  async function duplicate() {
    setLoading(true)
    const { data: doc, error } = await supabase
      .from('documents')
      .select('*, document_items(*)')
      .eq('id', docId)
      .single()

    if (error || !doc) { toast.error('Could not load document.'); setLoading(false); return }

    const { data: newDoc, error: insertErr } = await supabase
      .from('documents')
      .insert({
        type: doc.type,
        client_id: doc.client_id,
        date: today(),
        due_date: null,
        service_date: null,
        language: doc.language,
        currency: doc.currency,
        tax_treatment: doc.tax_treatment,
        notes: doc.notes,
        notes_internal: null,
        discount_type: doc.discount_type,
        discount_value: doc.discount_value,
        status: 'draft',
        number: null,
      })
      .select()
      .single()

    if (insertErr || !newDoc) { toast.error('Could not duplicate.'); setLoading(false); return }

    const items = (doc.document_items ?? []).map(({ id: _id, document_id: _did, created_at: _ca, ...rest }: Record<string, unknown>) => ({
      ...rest,
      document_id: newDoc.id,
    }))

    if (items.length > 0) {
      await supabase.from('document_items').insert(items)
    }

    toast.success('Duplicated as draft.')
    router.push(`${backTo}/${newDoc.id}`)
  }

  return (
    <button
      onClick={duplicate}
      disabled={loading}
      title="Duplicate as draft"
      className="flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors disabled:opacity-50"
    >
      <Copy size={14} /> <span className="hidden sm:inline">{loading ? 'Duplicating…' : 'Duplicate'}</span>
    </button>
  )
}
