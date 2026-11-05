import { createClient } from '@/lib/supabase/server'
import RecurringList, { type ScheduleRow } from '@/components/recurring/RecurringList'
import { getT } from '@/lib/i18n/server'
import { clientDisplayName } from '@/lib/utils/clients'
import type { RecurringSchedule } from '@/types'

type DocRef = { id: string; number: string | null; clients: { name: string; company: string | null } | null }

export default async function RecurringPage() {
  const supabase = await createClient()
  const { t } = await getT()

  const { data: schedules } = await supabase.from('recurring_schedules').select('*').order('next_date')
  const list = (schedules ?? []) as RecurringSchedule[]

  const ids = Array.from(new Set(list.flatMap(s => [s.source_document_id, s.last_document_id]).filter((id): id is string => !!id)))
  // Without generated DB types supabase-js types the to-one `clients` embed as an array.
  const docs = ids.length
    ? (((await supabase.from('documents').select('id, number, clients(name, company)').in('id', ids)).data ?? []) as unknown as DocRef[])
    : []
  const byId = new Map(docs.map(d => [d.id, d]))

  const rows: ScheduleRow[] = list.map(s => {
    const source = byId.get(s.source_document_id)
    const last = s.last_document_id ? byId.get(s.last_document_id) : undefined
    return {
      ...s,
      source: source ? { id: source.id, number: source.number, client: clientDisplayName(source.clients) || '—' } : null,
      last: last ? { id: last.id, number: last.number } : null,
    }
  })

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-4">
      <h1 className="text-2xl font-semibold">{t('recurring.title')}</h1>
      <RecurringList schedules={rows} />
    </div>
  )
}
