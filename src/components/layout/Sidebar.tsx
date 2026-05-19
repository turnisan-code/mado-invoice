'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Users, FileText, MessageSquareQuote,
  BookOpen, Settings, BarChart3, LogOut, Moon, Sun
} from 'lucide-react'
import Logo from '@/components/ui/Logo'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useTheme } from 'next-themes'

const nav = [
  { href: '/dashboard',  label: 'Dashboard',  icon: LayoutDashboard },
  { href: '/clients',    label: 'Clients',     icon: Users },
  { href: '/invoices',   label: 'Invoices',    icon: FileText },
  { href: '/quotes',     label: 'Quotes',      icon: MessageSquareQuote },
  { href: '/catalogue',  label: 'Catalogue',   icon: BookOpen },
  { href: '/reports',    label: 'VAT Report',  icon: BarChart3 },
  { href: '/settings',   label: 'Settings',    icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const { theme, setTheme } = useTheme()

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside className="w-56 shrink-0 flex flex-col h-screen sticky top-0 border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <Link href="/dashboard" className="block px-4 py-5 border-b border-neutral-100 dark:border-neutral-800">
        <Logo />
      </Link>
      <nav className="flex-1 py-3 px-2 space-y-0.5">
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
              pathname.startsWith(href)
                ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium'
                : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-300'
            )}
          >
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </nav>
      <div className="p-2 border-t border-neutral-100 dark:border-neutral-800 space-y-0.5">
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
        <button
          onClick={signOut}
          className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
        >
          <LogOut size={16} />
          Sign out
        </button>
      </div>
    </aside>
  )
}
