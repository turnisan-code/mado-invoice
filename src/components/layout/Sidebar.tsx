'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Users, FileText, MessageSquareQuote,
  BookOpen, Settings, BarChart3, LogOut, Moon, Sun, FileX, Repeat
} from 'lucide-react'
import Logo from '@/components/ui/Logo'
import LanguageToggle from '@/components/layout/LanguageToggle'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useTheme } from 'next-themes'
import { useT } from '@/lib/i18n/client'
import type { DictKey } from '@/lib/i18n'

const nav: { href: string; label: DictKey; icon: typeof LayoutDashboard }[] = [
  { href: '/dashboard',     label: 'nav.dashboard',   icon: LayoutDashboard },
  { href: '/clients',       label: 'nav.clients',     icon: Users },
  { href: '/invoices',      label: 'nav.invoices',    icon: FileText },
  { href: '/quotes',        label: 'nav.quotes',      icon: MessageSquareQuote },
  { href: '/credit-notes',  label: 'nav.creditNotes', icon: FileX },
  { href: '/recurring',     label: 'nav.recurring',   icon: Repeat },
  { href: '/catalogue',     label: 'nav.catalogue',   icon: BookOpen },
  { href: '/reports',       label: 'nav.reports',     icon: BarChart3 },
  { href: '/settings',      label: 'nav.settings',    icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const { resolvedTheme, setTheme } = useTheme()
  const { t } = useT()

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside className="hidden md:flex w-56 shrink-0 flex-col h-screen sticky top-0 border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <Link href="/dashboard" aria-label={t('nav.logoLabel')} className="block px-4 py-5 border-b border-neutral-100 dark:border-neutral-800">
        <Logo />
      </Link>
      <nav aria-label={t('nav.main')} className="flex-1 py-3 px-2 space-y-0.5">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                active
                  ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium'
                  : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-300'
              )}
            >
              <Icon size={16} />
              {t(label)}
            </Link>
          )
        })}
      </nav>
      <div className="p-2 border-t border-neutral-100 dark:border-neutral-800 space-y-0.5">
        {/* Both icons/labels are rendered and toggled by the html class, so the server and the hydrating client agree. */}
        <button
          type="button"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
        >
          <Moon size={16} className="dark:hidden" />
          <Sun size={16} className="hidden dark:block" />
          <span className="dark:hidden">{t('nav.darkMode')}</span>
          <span className="hidden dark:inline">{t('nav.lightMode')}</span>
        </button>
        <LanguageToggle className="px-3 py-2 text-neutral-500 dark:text-neutral-400" />
        <button
          type="button"
          onClick={signOut}
          className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
        >
          <LogOut size={16} />
          {t('nav.signOut')}
        </button>
      </div>
    </aside>
  )
}
