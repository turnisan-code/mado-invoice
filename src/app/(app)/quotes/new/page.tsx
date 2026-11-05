import { createClient } from '@/lib/supabase/server'
import DocumentBuilder from '@/components/forms/DocumentBuilder'
import { toPublicSettings } from '@/lib/public-settings'
import SettingsMissing from '@/components/layout/SettingsMissing'
import { getT } from '@/lib/i18n/server'

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const { client } = await searchParams
  const supabase = await createClient()
  const { t } = await getT()

  const [{ data: settings }, { data: clients }, { data: catalogue }] = await Promise.all([
    supabase.from('settings').select('*').single(),
    supabase.from('clients').select('*').order('name'),
    supabase.from('catalogue_items').select('*').eq('active', true).order('sort_order'),
  ])

  if (!settings) return <SettingsMissing />

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">{t('documents.newQuote')}</h1>
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6">
        <DocumentBuilder
          type="quote"
          settings={toPublicSettings(settings)}
          clients={clients ?? []}
          catalogue={catalogue ?? []}
          defaultClientId={client}
        />
      </div>
    </div>
  )
}
