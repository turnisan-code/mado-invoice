import { createClient } from '@/lib/supabase/server'
import RecurringList, { type ScheduleRow } from '@/components/recurring/RecurringList'
import { getT } from '@/lib/i18n/server'
import { listRecurringSchedules } from '@/lib/services/queries'

export default async function RecurringPage() {
  const supabase = await createClient()
  const { t } = await getT()

  const rows: ScheduleRow[] = await listRecurringSchedules(supabase)

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-4">
      <h1 className="text-2xl font-semibold">{t('recurring.title')}</h1>
      <RecurringList schedules={rows} />
    </div>
  )
}
