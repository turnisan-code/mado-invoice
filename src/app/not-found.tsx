import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-50 dark:bg-neutral-950">
      <div className="w-full max-w-sm text-center space-y-4">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          This page does not exist or was removed. Check the link, or go back to the dashboard.
        </p>
        <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>Dashboard</Link>
      </div>
    </main>
  )
}
