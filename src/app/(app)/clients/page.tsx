import { createClient } from '@/lib/supabase/server'
import ClientList from '@/components/lists/ClientList'

export default async function ClientsPage() {
  const supabase = await createClient()

  const [{ data: clients }, { data: lastInvoices }] = await Promise.all([
    supabase.from('clients').select('*').order('name'),
    supabase.from('documents').select('client_id, date').eq('type', 'invoice').order('date', { ascending: false }),
  ])

  // Build a map of client_id → most recent invoice date
  const lastInvoicedMap: Record<string, string> = {}
  for (const inv of lastInvoices ?? []) {
    if (inv.client_id && !lastInvoicedMap[inv.client_id]) {
      lastInvoicedMap[inv.client_id] = inv.date
    }
  }

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <ClientList clients={clients ?? []} lastInvoicedMap={lastInvoicedMap} />
    </div>
  )
}
