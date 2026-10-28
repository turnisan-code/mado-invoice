'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/button'
import { useT } from '@/lib/i18n/client'

export default function ErrorPage({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  const { t } = useT()
  useEffect(() => { console.error(error) }, [error])

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-50 dark:bg-neutral-950">
      <div className="w-full max-w-sm text-center space-y-4">
        <h1 className="text-xl font-semibold">{t('errors.somethingWrong')}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('errors.rootNotLoaded')}
        </p>
        {error.digest && <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('errors.reference', { digest: error.digest })}</p>}
        <div className="flex justify-center gap-2">
          <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>{t('common.dashboard')}</Link>
          <Button type="button" onClick={() => unstable_retry()}>{t('common.tryAgain')}</Button>
        </div>
      </div>
    </main>
  )
}
