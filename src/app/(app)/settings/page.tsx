import { createClient } from '@/lib/supabase/server'
import SettingsForm from '@/components/forms/SettingsForm'
import { toPublicSettings } from '@/lib/public-settings'
import { getT } from '@/lib/i18n/server'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { t } = await getT()
  const { data: settings } = await supabase.from('settings').select('*').single()
  const publicSettings = settings ? toPublicSettings(settings) : null

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{t('settings.subtitle')}</p>
      </div>
      <SettingsForm settings={publicSettings} />
    </div>
  )
}
