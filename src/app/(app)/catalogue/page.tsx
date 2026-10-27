import { createClient } from '@/lib/supabase/server'
import CatalogueManager from '@/components/forms/CatalogueManager'
import { getT } from '@/lib/i18n/server'

export default async function CataloguePage() {
  const supabase = await createClient()
  const { t } = await getT()
  const { data: items } = await supabase
    .from('catalogue_items')
    .select('*')
    .order('sort_order')

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('catalogue.title')}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{t('catalogue.subtitle')}</p>
      </div>
      <CatalogueManager initialItems={items ?? []} />
    </div>
  )
}
