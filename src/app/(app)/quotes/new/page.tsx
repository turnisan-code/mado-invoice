import { createClient } from '@/lib/supabase/server'
import DocumentBuilder from '@/components/forms/DocumentBuilder'

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const { client } = await searchParams
  const supabase = await createClient()

  const [{ data: settings }, { data: clients }, { data: catalogue }] = await Promise.all([
    supabase.from('settings').select('*').single(),
    supabase.from('clients').select('id, name, company, email, language, currency, payment_days, tax_treatment, address_line1, address_line2, zip, city, country, uid_number').order('name'),
    supabase.from('catalogue_items').select('*').order('sort_order'),
  ])

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">New Quote</h1>
      <div className="bg-white rounded-xl border border-neutral-200 p-6">
        <DocumentBuilder
          type="quote"
          settings={settings!}
          clients={clients ?? []}
          catalogue={catalogue ?? []}
          defaultClientId={client}
        />
      </div>
    </div>
  )
}
