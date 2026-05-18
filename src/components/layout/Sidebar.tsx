'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Users, FileText, MessageSquareQuote,
  BookOpen, Settings, BarChart3, LogOut
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

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

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside className="w-56 shrink-0 flex flex-col h-screen sticky top-0 border-r border-neutral-200 bg-white">
      <div className="px-5 py-5 border-b border-neutral-100">
        <span className="font-semibold text-sm tracking-wide">Mado Invoice</span>
      </div>
      <nav className="flex-1 py-3 px-2 space-y-0.5">
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
              pathname.startsWith(href)
                ? 'bg-neutral-100 text-neutral-900 font-medium'
                : 'text-neutral-500 hover:bg-neutral-50 hover:text-neutral-700'
            )}
          >
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </nav>
      <div className="p-2 border-t border-neutral-100">
        <button
          onClick={signOut}
          className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm text-neutral-400 hover:text-neutral-600 hover:bg-neutral-50 transition-colors"
        >
          <LogOut size={16} />
          Sign out
        </button>
      </div>
    </aside>
  )
}
