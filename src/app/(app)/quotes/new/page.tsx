import { createClient } from '@/lib/supabase/server'
import DocumentBuilder from '@/components/forms/DocumentBuilder'

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const { client } = await searchParams
  const supabase = await createClient()

  const [{ data: settings }, { data: clients }, { data: catalogue }] = await Promise.all([
    supabase.from('settings').select('*').single(),
    supabase.from('clients').select('*').order('name'),
    supabase.from('catalogue_items').select('*').eq('active', true).order('sort_order'),
  ])

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">New Quote</h1>
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6">
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
