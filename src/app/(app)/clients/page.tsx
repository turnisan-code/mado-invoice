import { createClient } from '@/lib/supabase/server'
import ClientList from '@/components/lists/ClientList'

export default async function ClientsPage() {
  const supabase = await createClient()

  const { data: clients } = await supabase
    .from('clients')
    .select('*')
    .order('name')

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <ClientList clients={clients ?? []} />
    </div>
  )
}
