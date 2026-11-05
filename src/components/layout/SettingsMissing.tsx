import Link from 'next/link'
import { getT } from '@/lib/i18n/server'

// The editor pages show this instead of crashing when there is no settings row: nothing can be
// written or issued without the company details, so the way forward is Settings.
export default async function SettingsMissing() {
  const { t } = await getT()
  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto">
      <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 p-4 sm:p-6 space-y-2 text-sm text-amber-800 dark:text-amber-300">
        <p className="font-semibold">{t('issueChecks.settingsMissingTitle')}</p>
        <p>{t('issueChecks.settingsMissingBody')}</p>
        <Link href="/settings" className="inline-block font-medium underline underline-offset-2 py-2 -my-1">{t('issueChecks.openSettings')}</Link>
      </div>
    </div>
  )
}
