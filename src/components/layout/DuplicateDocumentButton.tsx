'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Copy } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { today } from '@/lib/utils/document'
import { clientTerms } from '@/components/forms/builder/model'
import { useT } from '@/lib/i18n/client'
import type { DocumentType } from '@/types'

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
    const [{ data: doc, error }, { data: settings, error: settingsErr }] = await Promise.all([
      supabase.from('documents').select('*, document_items(*), clients(payment_days, skonto_percent, skonto_days)').eq('id', docId).single(),
      supabase.from('settings').select('default_payment_days, default_quote_validity_days, default_skonto_percent, default_skonto_days').maybeSingle(),
    ])

    if (error || !doc || settingsErr || !settings) { toast.error(t('documents.couldNotLoad')); setLoading(false); return }

    // The copy is a new document: dated today, due and with Skonto as the client's terms say.
    const date = today()
    const type = doc.type as DocumentType
    const terms = clientTerms(type, settings, doc.clients ?? { payment_days: null }, date)

    const { data: newDoc, error: insertErr } = await supabase
      .from('documents')
      .insert({
        type: doc.type,
        client_id: doc.client_id,
        date,
        due_date: type === 'credit_note' ? null : terms.dueDate,
        service_date: null,
        language: doc.language,
        // EUR only: a copy of an old USD/GBP document starts as a EUR draft.
        currency: 'EUR',
        exchange_rate: 1,
        tax_treatment: doc.tax_treatment,
        notes: doc.notes,
        notes_internal: null,
        discount_type: doc.discount_type,
        discount_value: doc.discount_value,
        skonto_percent: terms.skontoPercent === '' ? null : terms.skontoPercent,
        skonto_days: terms.skontoDays === '' ? null : terms.skontoDays,
        status: 'draft',
        number: null,
      })
      .select()
      .single()

    if (insertErr || !newDoc) { toast.error(t('documents.couldNotDuplicate')); setLoading(false); return }

    const items = (doc.document_items ?? []).map((item: Record<string, unknown>) => {
      const { id: _id, document_id: _did, created_at: _ca, ...rest } = item
      return { ...rest, document_id: newDoc.id }
    })

    if (items.length > 0) {
      const { error: itemsErr } = await supabase.from('document_items').insert(items)
      if (itemsErr) {
        // A copy without its lines is no copy; the empty draft goes again.
        const { error: cleanupErr } = await supabase.from('documents').delete().eq('id', newDoc.id).is('number', null)
        if (cleanupErr) console.error('[duplicate] empty draft not removed:', cleanupErr.message)
        toast.error(t('documents.couldNotDuplicate'))
        setLoading(false)
        return
      }
    }

    toast.success(t('documents.duplicated'))
    router.push(`${backTo}/${newDoc.id}`)
  }

  return (
    <Button type="button" variant="outline" onClick={duplicate} disabled={loading} title={t('documents.duplicateTitle')}>
      <Copy size={14} /> <span className="sr-only sm:not-sr-only">{loading ? t('documents.duplicating') : t('documents.duplicate')}</span>
    </Button>
  )
}
