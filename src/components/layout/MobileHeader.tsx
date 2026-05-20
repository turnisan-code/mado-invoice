'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  LayoutDashboard, Users, FileText, MessageSquareQuote,
  BookOpen, Settings, BarChart3, LogOut, Moon, Sun, FileX, MoreHorizontal, X,
} from 'lucide-react'
import Logo from '@/components/ui/Logo'
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
  const { theme, setTheme } = useTheme()

  async function signOut() {
    setMoreOpen(false)
    await supabase.auth.signOut()
    router.push('/login')
  }

  const isMore = MORE_NAV.some(n => pathname.startsWith(n.href))

  return (
    <>
      {/* Slim top bar — logo only */}
      <div className="md:hidden flex items-center px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        <Link href="/dashboard">
          <Logo />
        </Link>
      </div>

      {/* Bottom tab bar */}
      <div className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white dark:bg-neutral-900 border-t border-neutral-200 dark:border-neutral-800 flex items-stretch safe-bottom">
        {PRIMARY_NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
                active
                  ? 'text-neutral-900 dark:text-neutral-100'
                  : 'text-neutral-400 dark:text-neutral-500'
              )}
            >
              <Icon size={22} strokeWidth={active ? 2.2 : 1.7} />
              {label}
            </Link>
          )
        })}
        {/* More button */}
        <button
          onClick={() => setMoreOpen(true)}
          className={cn(
            'flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
            isMore
              ? 'text-neutral-900 dark:text-neutral-100'
              : 'text-neutral-400 dark:text-neutral-500'
          )}
        >
          <MoreHorizontal size={22} strokeWidth={isMore ? 2.2 : 1.7} />
          More
        </button>
      </div>

      {/* "More" bottom sheet */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end">
          {/* Scrim */}
          <div className="absolute inset-0 bg-black/40" onClick={() => setMoreOpen(false)} />

          {/* Sheet */}
          <div className="relative bg-white dark:bg-neutral-900 rounded-t-2xl shadow-xl pb-safe">
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-neutral-200 dark:bg-neutral-700" />
            </div>

            <div className="px-4 pb-2 pt-1 flex items-center justify-between">
              <span className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">More</span>
              <button onClick={() => setMoreOpen(false)} className="p-1.5 rounded-full text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors">
                <X size={16} />
              </button>
            </div>

            <nav className="px-2 pb-2 space-y-0.5">
              {MORE_NAV.map(({ href, label, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    'flex items-center gap-3 px-3 py-3 rounded-xl text-sm transition-colors',
                    pathname.startsWith(href)
                      ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium'
                      : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                  )}
                >
                  <Icon size={18} />
                  {label}
                </Link>
              ))}
            </nav>

            <div className="mx-2 border-t border-neutral-100 dark:border-neutral-800 pt-1 pb-2 space-y-0.5">
              <button
                onClick={() => { setTheme(theme === 'dark' ? 'light' : 'dark'); setMoreOpen(false) }}
                className="flex w-full items-center gap-3 px-3 py-3 rounded-xl text-sm text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                {theme === 'dark' ? 'Light mode' : 'Dark mode'}
              </button>
              <button
                onClick={signOut}
                className="flex w-full items-center gap-3 px-3 py-3 rounded-xl text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
              >
                <LogOut size={18} />
                Sign out
              </button>
            </div>

            {/* iOS safe area spacer */}
            <div className="h-safe-bottom" />
          </div>
        </div>
      )}
    </>
  )
}
