import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import Sidebar from '@/components/layout/Sidebar'
import MobileHeader from '@/components/layout/MobileHeader'
import PageTransition from '@/components/layout/PageTransition'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // The window is the scroll container: <main> must not get overflow-auto/hidden, or the in-page
  // sticky bars (builder actions, bank import) stick to <main> instead of the viewport. overflow-x
  // clip keeps wide content from panning the page sideways without creating a scroll container.
  return (
    <div className="flex min-h-dvh pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] bg-neutral-50 dark:bg-neutral-950">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <MobileHeader />
        <main className="flex-1 min-w-0 overflow-x-clip pb-[calc(5rem_+_env(safe-area-inset-bottom))] md:pt-[env(safe-area-inset-top)] md:pb-[env(safe-area-inset-bottom)]">
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
    </div>
  )
}
