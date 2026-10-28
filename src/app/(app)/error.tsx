'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/button'

export default function AppError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => { console.error(error) }, [error])

  return (
    <div className="p-4 sm:p-8 max-w-2xl mx-auto">
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6 sm:p-8 text-center space-y-4">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          This page could not be loaded. Nothing was lost — try again, or go back to the dashboard.
        </p>
        {error.digest && <p className="text-xs text-neutral-500 dark:text-neutral-400">Reference: {error.digest}</p>}
        <div className="flex justify-center gap-2">
          <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>Dashboard</Link>
          <Button type="button" onClick={() => unstable_retry()}>Try again</Button>
        </div>
      </div>
    </div>
  )
}
