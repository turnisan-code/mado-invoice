import {
  LayoutDashboard, Users, FileText, MessageSquareQuote, FileX, Repeat,
  BookOpen, BarChart3, Settings, ShieldCheck, type LucideIcon,
} from 'lucide-react'
import type { DictKey } from '@/lib/i18n'

export type NavItem = {
  href: string
  label: DictKey
  icon: LucideIcon
  /** Position in the mobile bottom tab bar; items without one live in the "More" sheet. */
  tab?: number
}

// Sidebar order. The mobile tab bar reorders its four items by `tab`.
export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard',    label: 'nav.dashboard',   icon: LayoutDashboard, tab: 0 },
  { href: '/clients',      label: 'nav.clients',     icon: Users,           tab: 2 },
  { href: '/invoices',     label: 'nav.invoices',    icon: FileText,        tab: 1 },
  { href: '/quotes',       label: 'nav.quotes',      icon: MessageSquareQuote, tab: 3 },
  { href: '/credit-notes', label: 'nav.creditNotes', icon: FileX },
  { href: '/recurring',    label: 'nav.recurring',   icon: Repeat },
  { href: '/catalogue',    label: 'nav.catalogue',   icon: BookOpen },
  { href: '/reports',      label: 'nav.reports',     icon: BarChart3 },
  { href: '/settings',     label: 'nav.settings',    icon: Settings },
]

export const MOBILE_TABS = NAV_ITEMS.filter(item => item.tab !== undefined).sort((a, b) => (a.tab ?? 0) - (b.tab ?? 0))
export const MOBILE_MORE = NAV_ITEMS.filter(item => item.tab === undefined)

// Linked from the sidebar footer and the mobile "More" sheet, next to theme, language and sign-out.
export const ACCOUNT_ITEM: NavItem = { href: '/account', label: 'account.title', icon: ShieldCheck }

export function isNavActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}
