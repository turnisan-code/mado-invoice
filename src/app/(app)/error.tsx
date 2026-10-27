'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/button'
import { useT } from '@/lib/i18n/client'

export default function AppError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  const { t } = useT()
  useEffect(() => { console.error(error) }, [error])

  return (
    <div className="p-4 sm:p-8 max-w-2xl mx-auto">
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6 sm:p-8 text-center space-y-4">
        <h1 className="text-xl font-semibold">{t('errors.somethingWrong')}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('errors.pageNotLoaded')}
        </p>
        {error.digest && <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('errors.reference', { digest: error.digest })}</p>}
        <div className="flex justify-center gap-2">
          <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>{t('common.dashboard')}</Link>
          <Button type="button" onClick={() => unstable_retry()}>{t('common.tryAgain')}</Button>
        </div>
      </div>
    </div>
  )
}
