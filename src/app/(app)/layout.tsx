import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import { isGoogleExpired } from '@/lib/public-settings'
import Sidebar from '@/components/layout/Sidebar'
import MobileHeader from '@/components/layout/MobileHeader'
import PageTransition from '@/components/layout/PageTransition'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // A revoked or expired Google grant (invalid_grant) stops Gmail sending, Drive archiving and
  // the automatic reminders; say so on every page, not only in Settings.
  const [{ data: google }, { t }] = await Promise.all([
    supabase.from('settings').select('gmail_email, gmail_refresh_token').maybeSingle(),
    getT(),
  ])
  const googleExpired = !!google && isGoogleExpired(google)

  // The window is the scroll container: <main> must not get overflow-auto/hidden, or the in-page
  // sticky bars (builder actions, bank import) stick to <main> instead of the viewport. overflow-x
  // clip keeps wide content from panning the page sideways without creating a scroll container.
  return (
    <div className="flex min-h-dvh pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] bg-neutral-50 dark:bg-neutral-950">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <MobileHeader />
        <main className="flex-1 min-w-0 overflow-x-clip pb-[calc(5rem_+_env(safe-area-inset-bottom))] md:pt-[env(safe-area-inset-top)] md:pb-[env(safe-area-inset-bottom)]">
          {googleExpired && (
            <div className="px-4 sm:px-8 pt-4">
              <div role="alert" className="max-w-5xl mx-auto flex items-start gap-2 px-4 py-3 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-sm text-amber-800 dark:text-amber-300">
                <AlertTriangle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />
                <span className="min-w-0">
                  {t('books.google.expiredBanner', { email: google!.gmail_email ?? '' })}{' '}
                  <Link href="/settings?section=integrations" className="font-medium underline underline-offset-2">{t('books.google.reconnect')}</Link>
                </span>
              </div>
            </div>
          )}
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
    </div>
  )
}
