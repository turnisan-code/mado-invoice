import type { Metadata } from 'next'
import Link from 'next/link'
import Logo from '@/components/ui/Logo'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT()
  return { title: t('mcp.approve.title'), robots: { index: false, follow: false } }
}

// Approvals open from a link in Claude, often on the phone: a page of their own, without the
// app's navigation. The proxy has already asked for the password and the authenticator code.
export default async function McpLayout({ children }: { children: React.ReactNode }) {
  const { t } = await getT()
  return (
    <main className="min-h-dvh px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] bg-neutral-50 dark:bg-neutral-950">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="flex items-center justify-between gap-3">
          <Link href="/dashboard" aria-label={t('mcp.approve.backToApp')} className="text-neutral-900 dark:text-neutral-100">
            <Logo className="h-6 w-auto" />
          </Link>
          <Link href="/dashboard" className="text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100">
            {t('mcp.approve.backToApp')}
          </Link>
        </header>
        {children}
      </div>
    </main>
  )
}
