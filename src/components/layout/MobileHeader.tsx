'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  LayoutDashboard, Users, FileText, MessageSquareQuote,
  BookOpen, Settings, BarChart3, LogOut, Moon, Sun, FileX, MoreHorizontal, X,
} from 'lucide-react'
import Logo from '@/components/ui/Logo'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { createClient } from '@/lib/supabase/client'
import { useTheme } from 'next-themes'
import { cn } from '@/lib/utils'

// Primary tabs shown in the bottom bar
const PRIMARY_NAV = [
  { href: '/dashboard',  label: 'Dashboard', icon: LayoutDashboard },
  { href: '/invoices',   label: 'Invoices',  icon: FileText },
  { href: '/clients',    label: 'Clients',   icon: Users },
  { href: '/quotes',     label: 'Quotes',    icon: MessageSquareQuote },
]

// Overflow items in the "More" bottom sheet
const MORE_NAV = [
  { href: '/credit-notes', label: 'Credit Notes', icon: FileX },
  { href: '/catalogue',    label: 'Catalogue',     icon: BookOpen },
  { href: '/reports',      label: 'VAT Report',    icon: BarChart3 },
  { href: '/settings',     label: 'Settings',      icon: Settings },
]

export default function MobileHeader() {
  const [moreOpen, setMoreOpen] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const { resolvedTheme, setTheme } = useTheme()

  async function signOut() {
    setMoreOpen(false)
    await supabase.auth.signOut()
    router.push('/login')
  }

  const isMore = MORE_NAV.some(n => pathname.startsWith(n.href))

  return (
    <>
      {/* Slim top bar — logo only; padded below the iOS status bar in the installed app */}
      <div
        className="md:hidden sticky top-0 z-30 flex items-center px-4 pb-3 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <Link href="/dashboard" aria-label="Mado Invoice — Dashboard" className="rounded-md">
          <Logo />
        </Link>
      </div>

      {/* Bottom tab bar */}
      <nav
        aria-label="Main"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white dark:bg-neutral-900 border-t border-neutral-200 dark:border-neutral-800 flex items-stretch"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {PRIMARY_NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex-1 h-14 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors',
                active
                  ? 'text-neutral-900 dark:text-neutral-100'
                  : 'text-neutral-500 dark:text-neutral-400'
              )}
            >
              <Icon size={22} strokeWidth={active ? 2.2 : 1.7} />
              {label}
            </Link>
          )
        })}
        {/* More button */}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={cn(
            'flex-1 h-14 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors',
            isMore
              ? 'text-neutral-900 dark:text-neutral-100'
              : 'text-neutral-500 dark:text-neutral-400'
          )}
        >
          <MoreHorizontal size={22} strokeWidth={isMore ? 2.2 : 1.7} />
          More
        </button>
      </nav>

      {/* "More" bottom sheet */}
      <Dialog
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        align="bottom"
        title="More"
        hideTitle
        panelClassName="md:hidden bg-white dark:bg-neutral-900"
      >
        <div style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {/* Handle */}
          <div className="flex justify-center pt-3 pb-1">
            <div className="w-10 h-1 rounded-full bg-neutral-200 dark:bg-neutral-700" />
          </div>

          <div className="px-4 pb-2 pt-1 flex items-center justify-between">
            <span aria-hidden="true" className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">More</span>
            <button
              type="button"
              onClick={() => setMoreOpen(false)}
              aria-label="Close"
              className="h-11 w-11 -mr-3 flex items-center justify-center rounded-full text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <nav aria-label="More" className="px-2 pb-2 space-y-0.5">
            {MORE_NAV.map(({ href, label, icon: Icon }) => {
              const active = pathname.startsWith(href)
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    'flex items-center gap-3 px-3 py-3 rounded-xl text-sm transition-colors',
                    active
                      ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium'
                      : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                  )}
                >
                  <Icon size={18} />
                  {label}
                </Link>
              )
            })}
          </nav>

          <div className="mx-2 border-t border-neutral-100 dark:border-neutral-800 pt-1 pb-2 space-y-0.5">
            {/* Both icons/labels are rendered and toggled by the html class, so the server and the hydrating client agree. */}
            <button
              type="button"
              onClick={() => { setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'); setMoreOpen(false) }}
              className="flex w-full items-center gap-3 px-3 py-3 rounded-xl text-sm text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
            >
              <Moon size={18} className="dark:hidden" />
              <Sun size={18} className="hidden dark:block" />
              <span className="dark:hidden">Dark mode</span>
              <span className="hidden dark:inline">Light mode</span>
            </button>
            <button
              type="button"
              onClick={signOut}
              className="flex w-full items-center gap-3 px-3 py-3 rounded-xl text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
            >
              <LogOut size={18} />
              Sign out
            </button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
