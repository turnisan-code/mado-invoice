import { createClient } from '@/lib/supabase/server'
import SettingsForm from '@/components/forms/SettingsForm'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: settings } = await supabase.from('settings').select('*').single()

  return (
    <div className="p-4 sm:p-8 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">Your business details printed on every invoice and quote.</p>
      </div>
      <SettingsForm settings={settings} />
    </div>
  )
}
