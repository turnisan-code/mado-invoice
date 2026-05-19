import { createClient } from '@/lib/supabase/server'
import { calcTotals } from '@/lib/utils/document'
import { formatMoney } from '@/lib/utils/document'
import { markOverdueInvoices } from '@/lib/utils/overdue'
import { FileText, CheckCircle, AlertTriangle, TrendingUp } from 'lucide-react'
import Link from 'next/link'

export default async function DashboardPage() {
  const supabase = await createClient()
  void markOverdueInvoices(supabase)

  const [{ data: invoices }, { data: quotes }] = await Promise.all([
    supabase
      .from('documents')
      .select('id, number, status, date, due_date, currency, clients(name), document_items(line_type, quantity, unit_price, vat_rate), payments(amount, date)')
      .eq('type', 'invoice')
      .order('date', { ascending: false }),
    supabase
      .from('documents')
      .select('id, number, status, date, clients(name)')
      .eq('type', 'quote')
      .in('status', ['draft', 'sent'])
      .order('date', { ascending: false })
      .limit(5),
  ])

  const now = new Date().toISOString().split('T')[0]
  const thisMonth = now.slice(0, 7)
  const thisYear = now.slice(0, 4)
  const lastMonthDate = new Date(); lastMonthDate.setMonth(lastMonthDate.getMonth() - 1)
  const lastMonth = lastMonthDate.toISOString().slice(0, 7)

  const allInvoices = invoices ?? []

  const getTotal = (doc: typeof allInvoices[0]) =>
    calcTotals(doc.document_items ?? [], doc.payments ?? []).total

  const getPaid = (doc: typeof allInvoices[0]) =>
    calcTotals(doc.document_items ?? [], doc.payments ?? []).total_paid

  const open = allInvoices.filter(i => i.status === 'sent' && (i.due_date ?? '9999') >= now)
  const overdue = allInvoices.filter(i => i.status === 'overdue' || (i.status === 'sent' && i.due_date && i.due_date < now))
  const paidThisMonth = allInvoices.filter(i =>
    i.status === 'paid' && (i.payments ?? []).some((p: { date: string }) => p.date?.startsWith(thisMonth))
  )
  const paidLastMonth = allInvoices.filter(i =>
    i.status === 'paid' && (i.payments ?? []).some((p: { date: string }) => p.date?.startsWith(lastMonth))
  )
  const revenueThisMonth = paidThisMonth.reduce((s, d) => s + getPaid(d), 0)
  const revenueLastMonth = paidLastMonth.reduce((s, d) => s + getPaid(d), 0)
  const momDelta = revenueLastMonth > 0 ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100) : null
  const revenueThisYear = allInvoices
    .filter(i => i.status === 'paid' && i.date?.startsWith(thisYear))
    .reduce((s, doc) => s + getPaid(doc), 0)

  const oldestOverdueDays = overdue.length > 0
    ? Math.max(...overdue.filter(i => i.due_date).map(i => Math.floor((new Date(now).getTime() - new Date(i.due_date!).getTime()) / 86400000)))
    : null

  const recentInvoices = allInvoices.slice(0, 10)

  const stats = [
    { label: 'Open', value: open.length, amount: open.reduce((s, d) => s + getTotal(d), 0), sub: null, icon: FileText, color: 'text-blue-600 bg-blue-50 dark:bg-blue-950', href: '/invoices?status=sent' },
    { label: 'Overdue', value: overdue.length, amount: overdue.reduce((s, d) => s + getTotal(d), 0), sub: oldestOverdueDays != null ? `oldest: ${oldestOverdueDays}d` : null, icon: AlertTriangle, color: 'text-red-600 bg-red-50 dark:bg-red-950', href: '/invoices?status=overdue' },
    { label: 'Paid this month', value: paidThisMonth.length, amount: revenueThisMonth, sub: momDelta != null ? `${momDelta >= 0 ? '+' : ''}${momDelta}% vs last month` : null, icon: CheckCircle, color: 'text-green-600 bg-green-50 dark:bg-green-950', href: null },
    { label: `Revenue ${thisYear}`, value: null, amount: revenueThisYear, sub: null, icon: TrendingUp, color: 'text-purple-600 bg-purple-50 dark:bg-purple-950', href: null },
  ]

  const statusLabel: Record<string, string> = {
    draft: 'Draft', sent: 'Sent', paid: 'Paid', overdue: 'Overdue', cancelled: 'Cancelled'
  }
  const statusColor: Record<string, string> = {
    draft: 'text-neutral-400 bg-neutral-100',
    sent: 'text-blue-700 bg-blue-100',
    paid: 'text-green-700 bg-green-100',
    overdue: 'text-red-700 bg-red-100',
    cancelled: 'text-neutral-400 bg-neutral-100',
  }

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="flex gap-2">
          <Link href="/quotes/new" className="text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
            New Quote
          </Link>
          <Link href="/invoices/new" className="text-sm px-3 py-1.5 rounded-md bg-neutral-900 text-white hover:bg-neutral-700 transition-colors">
            New Invoice
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(({ label, value, amount, sub, icon: Icon, color, href }) => {
          const inner = (
            <>
              <div className="flex items-center justify-between">
                <span className="text-sm text-neutral-500 dark:text-neutral-400">{label}</span>
                <span className={`p-1.5 rounded-md ${color}`}><Icon size={14} /></span>
              </div>
              <div>
                {value !== null && <div className="text-2xl font-semibold">{value}</div>}
                <div className={value !== null ? 'text-sm text-neutral-400 dark:text-neutral-500' : 'text-2xl font-semibold'}>{formatMoney(amount)}</div>
                {sub && <div className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">{sub}</div>}
              </div>
            </>
          )
          return href ? (
            <Link key={label} href={href} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 space-y-3 hover:border-neutral-300 dark:hover:border-neutral-600 transition-colors block">
              {inner}
            </Link>
          ) : (
            <div key={label} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 space-y-3">
              {inner}
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700">
          <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
            <span className="font-medium text-sm">Recent Invoices</span>
            <Link href="/invoices" className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300">View all →</Link>
          </div>
          <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {recentInvoices.length === 0 && (
              <p className="px-5 py-8 text-sm text-neutral-400 dark:text-neutral-500 text-center">No invoices yet.</p>
            )}
            {recentInvoices.map((inv) => {
              const totals = calcTotals(inv.document_items ?? [], inv.payments ?? [])
              const clientName = (inv.clients as unknown as { name: string } | null)?.name
              return (
                <Link key={inv.id} href={`/invoices/${inv.id}`} className="flex items-center px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{inv.number}</div>
                    {clientName && <div className="text-xs text-neutral-400 dark:text-neutral-500">{clientName}</div>}
                  </div>
                  <div className="text-sm font-medium text-right shrink-0">
                    {formatMoney(totals.total, inv.currency)}
                    {totals.total_paid > 0 && totals.balance_due > 0.005 && (
                      <div className="text-xs text-amber-600">{formatMoney(totals.balance_due, inv.currency)} due</div>
                    )}
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${statusColor[inv.status] ?? ''}`}>
                    {statusLabel[inv.status] ?? inv.status}
                  </span>
                </Link>
              )
            })}
          </div>
        </div>

        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700">
          <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
            <span className="font-medium text-sm">Pending Quotes</span>
            <Link href="/quotes" className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300">View all →</Link>
          </div>
          <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {(quotes?.length ?? 0) === 0 && (
              <p className="px-5 py-8 text-sm text-neutral-400 dark:text-neutral-500 text-center">No pending quotes.</p>
            )}
            {quotes?.map((q) => {
              const clientName = (q.clients as unknown as { name: string } | null)?.name
              return (
                <Link key={q.id} href={`/quotes/${q.id}`} className="flex items-center px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{q.number}</div>
                    {clientName && <div className="text-xs text-neutral-400 dark:text-neutral-500">{clientName}</div>}
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${statusColor[q.status] ?? ''}`}>
                    {statusLabel[q.status] ?? q.status}
                  </span>
                </Link>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
