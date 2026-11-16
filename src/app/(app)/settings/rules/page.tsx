import { createClient } from '@/lib/supabase/server'
import BookingRulesEditor from '@/components/bank/BookingRulesEditor'
import { today } from '@/lib/utils/document'
import type { BookingRule } from '@/types'

// Einstellungen → „Buchungsregeln“ (PR 9a)
export default async function BookingRulesPage() {
  const supabase = await createClient()
  const [{ data: rules }, { data: settings }] = await Promise.all([
    supabase.from('booking_rules').select('*').order('name').order('id'),
    supabase.from('settings').select('id, iban, own_ibans').single(),
  ])
  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <BookingRulesEditor
        rules={(rules ?? []) as BookingRule[]}
        settingsId={settings?.id ?? ''}
        invoiceIban={settings?.iban ?? ''}
        ownIbans={(settings?.own_ibans as string[] | null) ?? []}
        year={Number(today().slice(0, 4))}
      />
    </div>
  )
}
