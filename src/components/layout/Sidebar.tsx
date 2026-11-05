'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LogOut, Moon, Sun } from 'lucide-react'
import Logo from '@/components/ui/Logo'
import LanguageToggle from '@/components/layout/LanguageToggle'
import { ACCOUNT_ITEM, NAV_ITEMS, isNavActive } from '@/components/layout/nav'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { useTheme } from 'next-themes'
import { useT } from '@/lib/i18n/client'

export default function Sidebar() {
  const pathname = usePathname()
  const { resolvedTheme, setTheme } = useTheme()
  const { t } = useT()
  const accountActive = isNavActive(pathname, ACCOUNT_ITEM.href)

  // A full load drops the client router cache, so Back cannot show cached app pages after sign-out.
  async function signOut() {
    await createClient().auth.signOut()
    window.location.assign('/login')
  }

  return (
    <aside className="hidden md:flex w-56 shrink-0 flex-col h-dvh sticky top-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <Link href="/dashboard" aria-label={t('nav.logoLabel')} className="block px-4 py-5 border-b border-neutral-100 dark:border-neutral-800">
        <Logo />
      </Link>
      <nav aria-label={t('nav.main')} className="flex-1 min-h-0 overflow-y-auto py-3 px-2 space-y-0.5">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isNavActive(pathname, href)
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
        <Link
          href={ACCOUNT_ITEM.href}
          aria-current={accountActive ? 'page' : undefined}
          className={cn(
            'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
            accountActive
              ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium'
              : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800'
          )}
        >
          <ACCOUNT_ITEM.icon size={16} />
          {t(ACCOUNT_ITEM.label)}
        </Link>
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
