import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'

export default function AppNotFound() {
  return (
    <div className="p-4 sm:p-8 max-w-2xl mx-auto">
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6 sm:p-8 text-center space-y-4">
        <h1 className="text-xl font-semibold">Not found</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          This document or page does not exist or was deleted.
        </p>
        <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>Dashboard</Link>
      </div>
    </div>
  )
}
