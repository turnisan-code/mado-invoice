import { createClient } from '@/lib/supabase/server'
import CatalogueManager from '@/components/forms/CatalogueManager'
import { getT } from '@/lib/i18n/server'
import type { CatalogueUsage } from '@/types'

export default async function CataloguePage() {
  const supabase = await createClient()
  const { t } = await getT()
  const [{ data: items }, { data: usageRows }] = await Promise.all([
    supabase.from('catalogue_items').select('*').order('sort_order'),
    supabase.rpc('catalogue_usage'),
  ])
  const usage: Record<string, CatalogueUsage> = Object.fromEntries(
    ((usageRows ?? []) as { catalogue_item_id: string; uses: number; last_used: string | null }[])
      .map(r => [r.catalogue_item_id, { uses: Number(r.uses), lastUsed: r.last_used ?? null }]),
  )

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('catalogue.title')}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{t('catalogue.subtitle')}</p>
      </div>
      <CatalogueManager initialItems={items ?? []} usage={usage} />
    </div>
  )
}
