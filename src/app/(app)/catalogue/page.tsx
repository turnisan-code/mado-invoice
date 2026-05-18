import { createClient } from '@/lib/supabase/server'
import CatalogueManager from '@/components/forms/CatalogueManager'

export default async function CataloguePage() {
  const supabase = await createClient()
  const { data: items } = await supabase
    .from('catalogue_items')
    .select('*')
    .order('sort_order')

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Service Catalogue</h1>
        <p className="text-sm text-neutral-500 mt-1">Your standard services and prices. Pick from these when building invoices and quotes.</p>
      </div>
      <CatalogueManager initialItems={items ?? []} />
    </div>
  )
}
