'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { LogOut, Moon, Sun, MoreHorizontal, X } from 'lucide-react'
import Logo from '@/components/ui/Logo'
import LanguageToggle from '@/components/layout/LanguageToggle'
import { ACCOUNT_ITEM, MOBILE_MORE, MOBILE_TABS, isNavActive } from '@/components/layout/nav'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { createClient } from '@/lib/supabase/client'
import { useTheme } from 'next-themes'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n/client'

export default function MobileHeader() {
  const [moreOpen, setMoreOpen] = useState(false)
  const pathname = usePathname()
  const { resolvedTheme, setTheme } = useTheme()
  const { t } = useT()

  async function signOut() {
    setMoreOpen(false)
    await createClient().auth.signOut()
    window.location.assign('/login')
  }

  const accountActive = isNavActive(pathname, ACCOUNT_ITEM.href)
  const isMore = accountActive || MOBILE_MORE.some(n => isNavActive(pathname, n.href))

  return (
    <>
      {/* Slim top bar — logo only; padded below the iOS status bar in the installed app */}
      <div className="md:hidden sticky top-0 z-30 flex items-center px-4 pt-[calc(env(safe-area-inset-top)_+_0.75rem)] pb-3 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        <Link href="/dashboard" aria-label={t('nav.logoLabel')} className="rounded-md">
          <Logo />
        </Link>
      </div>

      {/* Bottom tab bar */}
      <nav
        aria-label={t('nav.main')}
        className="md:hidden fixed bottom-0 inset-x-0 z-40 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] bg-white dark:bg-neutral-900 border-t border-neutral-200 dark:border-neutral-800 flex items-stretch"
      >
        {MOBILE_TABS.map(({ href, label, icon: Icon }) => {
          const active = isNavActive(pathname, href)
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
              {t(label)}
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
          {t('nav.more')}
        </button>
      </nav>

      {/* "More" bottom sheet */}
      <Dialog
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        align="bottom"
        title={t('nav.more')}
        hideTitle
        panelClassName="md:hidden bg-white dark:bg-neutral-900"
      >
        <div className="pb-[env(safe-area-inset-bottom)]">
          {/* Handle */}
          <div className="flex justify-center pt-3 pb-1">
            <div className="w-10 h-1 rounded-full bg-neutral-200 dark:bg-neutral-700" />
          </div>

          <div className="px-4 pb-2 pt-1 flex items-center justify-between">
            <span aria-hidden="true" className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">{t('nav.more')}</span>
            <button
              type="button"
              onClick={() => setMoreOpen(false)}
              aria-label={t('common.close')}
              className="h-11 w-11 -mr-3 flex items-center justify-center rounded-full text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <nav aria-label={t('nav.more')} className="px-2 pb-2 space-y-0.5">
            {MOBILE_MORE.map(({ href, label, icon: Icon }) => {
              const active = isNavActive(pathname, href)
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
                  {t(label)}
                </Link>
              )
            })}
          </nav>

          <div className="mx-2 border-t border-neutral-100 dark:border-neutral-800 pt-1 pb-2 space-y-0.5">
            <Link
              href={ACCOUNT_ITEM.href}
              aria-current={accountActive ? 'page' : undefined}
              onClick={() => setMoreOpen(false)}
              className={cn(
                'flex items-center gap-3 px-3 py-3 rounded-xl text-sm transition-colors',
                accountActive
                  ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium'
                  : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800'
              )}
            >
              <ACCOUNT_ITEM.icon size={18} />
              {t(ACCOUNT_ITEM.label)}
            </Link>
            {/* Both icons/labels are rendered and toggled by the html class, so the server and the hydrating client agree. */}
            <button
              type="button"
              onClick={() => { setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'); setMoreOpen(false) }}
              className="flex w-full items-center gap-3 px-3 py-3 rounded-xl text-sm text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
            >
              <Moon size={18} className="dark:hidden" />
              <Sun size={18} className="hidden dark:block" />
              <span className="dark:hidden">{t('nav.darkMode')}</span>
              <span className="hidden dark:inline">{t('nav.lightMode')}</span>
            </button>
            <LanguageToggle iconSize={18} className="px-3 py-3 text-neutral-500 dark:text-neutral-400" />
            <button
              type="button"
              onClick={signOut}
              className="flex w-full items-center gap-3 px-3 py-3 rounded-xl text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
            >
              <LogOut size={18} />
              {t('nav.signOut')}
            </button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
