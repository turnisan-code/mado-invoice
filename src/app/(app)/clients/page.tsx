import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import ClientList, { type ClientRow } from '@/components/lists/ClientList'
import { listClients } from '@/lib/services/queries'

export default async function ClientsPage() {
  const supabase = await createClient()
  const { rows, lastInvoiced: lastInvoicedMap, balances: balanceMap } = await listClients(supabase)

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <Suspense>
        <ClientList clients={rows as ClientRow[]} lastInvoicedMap={lastInvoicedMap} balanceMap={balanceMap} />
      </Suspense>
    </div>
  )
}
