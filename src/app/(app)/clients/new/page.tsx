import ClientForm from '@/components/forms/ClientForm'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import { countryOptions } from '@/lib/utils/country'
import { CLIENT_DEFAULTS_COLUMNS, toClientDefaults } from '@/lib/utils/clients'

export default async function NewClientPage() {
  const supabase = await createClient()
  const { t, lang } = await getT()
  const { data: settings } = await supabase.from('settings').select(CLIENT_DEFAULTS_COLUMNS).maybeSingle()
  return (
    <div className="p-4 sm:p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">{t('clients.new')}</h1>
      <ClientForm defaults={toClientDefaults(settings)} countries={countryOptions(lang)} />
    </div>
  )
}
