import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { getT } from '@/lib/i18n/server'

export default async function NotFound() {
  const { t } = await getT()
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-50 dark:bg-neutral-950">
      <div className="w-full max-w-sm text-center space-y-4">
        <h1 className="text-xl font-semibold">{t('errors.pageNotFound')}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('errors.pageNotFoundDescription')}
        </p>
        <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>{t('common.dashboard')}</Link>
      </div>
    </main>
  )
}
