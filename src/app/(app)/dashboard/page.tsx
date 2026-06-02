import { createClient } from '@/lib/supabase/server'
import { calcTotals } from '@/lib/utils/document'
import { formatMoney } from '@/lib/utils/document'
import { FileText, CheckCircle, AlertTriangle, TrendingUp, Wallet } from 'lucide-react'
import Link from 'next/link'
import RevenueChart, { type MonthData } from '@/components/charts/RevenueChart'

export default async function DashboardPage() {
  const supabase = await createClient()

  const now = new Date().toISOString().split('T')[0]
  const thisMonth = now.slice(0, 7)
  const thisYear = now.slice(0, 4)
  const lastMonthDate = new Date(); lastMonthDate.setMonth(lastMonthDate.getMonth() - 1)
  const lastMonth = lastMonthDate.toISOString().slice(0, 7)

  // 13 months back covers the full 12-month chart window + last month's stats
  const chartCutoff = new Date()
  chartCutoff.setMonth(chartCutoff.getMonth() - 13)
  const chartCutoffStr = chartCutoff.toISOString().split('T')[0]

  const itemSelect = 'id, number, status, date, due_date, currency, clients(name), document_items(line_type, quantity, unit_price, vat_rate), payments(amount, date)'

  const [{ data: activeInvoices }, { data: paidInvoices }, { data: quotes }] = await Promise.all([
    // Open/overdue invoices — no date cap needed, these are currently active
    supabase
      .from('documents')
      .select(itemSelect)
      .eq('type', 'invoice')
      .in('status', ['sent', 'overdue']),
    // Paid invoices from the last 13 months — for chart, stats, and recently paid panel
    supabase
      .from('documents')
      .select(itemSelect)
      .eq('type', 'invoice')
      .eq('status', 'paid')
      .gte('date', chartCutoffStr)
      .order('date', { ascending: false }),
    supabase
      .from('documents')
      .select('id, number, status, date, clients(name)')
      .eq('type', 'quote')
      .in('status', ['draft', 'sent'])
      .order('date', { ascending: false })
      .limit(5),
  ])

  const active = activeInvoices ?? []
  const paid = paidInvoices ?? []

  const getTotal = (doc: typeof active[0]) =>
    calcTotals(doc.document_items ?? [], doc.payments ?? []).total

  const getPaid = (doc: typeof paid[0]) =>
    calcTotals(doc.document_items ?? [], doc.payments ?? []).total_paid

  const open = active.filter(i => i.status === 'sent' && (i.due_date ?? '9999') >= now)
  const overdue = active.filter(i => i.status === 'overdue' || (i.status === 'sent' && i.due_date && i.due_date < now))

  // Compute overdue total once — reused in KPI card and alert banner
  const overdueTotal = overdue.reduce((s, d) => s + getTotal(d), 0)
  const openTotal = open.reduce((s, d) => s + getTotal(d), 0)
  const outstanding = overdueTotal + openTotal
  const outstandingCount = open.length + overdue.length

  const oldestOverdueDays = overdue.length > 0
    ? Math.max(...overdue.filter(i => i.due_date).map(i =>
        Math.floor((new Date(now).getTime() - new Date(i.due_date!).getTime()) / 86400000)
      ))
    : null

  const paidThisMonth = paid.filter(i =>
    (i.payments ?? []).some((p: { date: string }) => p.date?.startsWith(thisMonth))
  )
  const paidLastMonth = paid.filter(i =>
    (i.payments ?? []).some((p: { date: string }) => p.date?.startsWith(lastMonth))
  )
  const revenueThisMonth = paidThisMonth.reduce((s, d) => s + getPaid(d), 0)
  const revenueLastMonth = paidLastMonth.reduce((s, d) => s + getPaid(d), 0)
  const momDelta = revenueLastMonth > 0
    ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
    : null
  const revenueThisYear = paid
    .filter(i => i.date?.startsWith(thisYear))
    .reduce((s, doc) => s + getPaid(doc), 0)

  const recentPaid = paid.slice(0, 6)

  // Build last 12 months bar chart data from payment dates
  const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const today = new Date()
  const months: MonthData[] = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth() - 11 + i, 1)
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    return { label: monthLabels[d.getMonth()], yearMonth: ym, revenue: 0, current: ym === thisMonth }
  })
  const monthMap = new Map(months.map((m, i) => [m.yearMonth, i]))

  for (const inv of paid) {
    for (const p of (inv.payments ?? []) as { amount: number; date: string }[]) {
      if (!p.date) continue
      const idx = monthMap.get(p.date.slice(0, 7))
      if (idx !== undefined) months[idx].revenue += p.amount
    }
  }

  const chartCurrency = (active[0] ?? paid[0])?.currency ?? 'EUR'

  const stats = [
    {
      label: 'Outstanding',
      value: outstandingCount,
      amount: outstanding,
      sub: overdue.length > 0 ? `${overdue.length} overdue` : null,
      subColor: overdue.length > 0 ? 'text-red-500' : undefined,
      icon: Wallet,
      color: 'text-amber-600 bg-amber-50 dark:bg-amber-950',
      href: '/invoices?status=sent',
    },
    {
      label: 'Overdue',
      value: overdue.length,
      amount: overdueTotal,
      sub: oldestOverdueDays != null ? `oldest: ${oldestOverdueDays}d` : null,
      subColor: undefined,
      icon: AlertTriangle,
      color: 'text-red-600 bg-red-50 dark:bg-red-950',
      href: '/invoices?status=overdue',
    },
    {
      label: 'Paid this month',
      value: paidThisMonth.length,
      amount: revenueThisMonth,
      sub: momDelta != null ? `${momDelta >= 0 ? '+' : ''}${momDelta}% vs last month` : null,
      subColor: undefined,
      icon: CheckCircle,
      color: 'text-green-600 bg-green-50 dark:bg-green-950',
      href: null,
    },
    {
      label: `Revenue ${thisYear}`,
      value: null,
      amount: revenueThisYear,
      sub: null,
      subColor: undefined,
      icon: TrendingUp,
      color: 'text-purple-600 bg-purple-50 dark:bg-purple-950',
      href: null,
    },
  ]

  const statusLabel: Record<string, string> = {
    draft: 'Draft', sent: 'Sent', paid: 'Paid', overdue: 'Overdue', cancelled: 'Cancelled'
  }
  const statusColor: Record<string, string> = {
    draft: 'text-neutral-400 bg-neutral-100 dark:bg-neutral-800',
    sent: 'text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300',
    paid: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
    overdue: 'text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300',
    cancelled: 'text-neutral-400 bg-neutral-100 dark:bg-neutral-800',
  }

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="flex gap-2">
          <Link href="/quotes/new" className="text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
            New Quote
          </Link>
          <Link href="/invoices/new" className="text-sm px-3 py-2 rounded-lg bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors">
            New Invoice
          </Link>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(({ label, value, amount, sub, subColor, icon: Icon, color, href }) => {
          const inner = (
            <>
              <div className="flex items-center justify-between">
                <span className="text-sm text-neutral-500 dark:text-neutral-400">{label}</span>
                <span className={`p-1.5 rounded-md ${color}`}><Icon size={14} /></span>
              </div>
              <div>
                {value !== null && <div className="text-2xl font-semibold">{value}</div>}
                <div className={value !== null ? 'text-sm text-neutral-400 dark:text-neutral-500' : 'text-2xl font-semibold'}>{formatMoney(amount)}</div>
                {sub && <div className={`text-xs mt-0.5 ${subColor ?? 'text-neutral-400 dark:text-neutral-500'}`}>{sub}</div>}
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

      {/* Revenue chart */}
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700">
        <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
          <div>
            <span className="font-medium text-sm">Monthly Revenue</span>
            <span className="ml-2 text-xs text-neutral-400 dark:text-neutral-500">last 12 months</span>
          </div>
          <span className="text-sm font-semibold">{formatMoney(revenueThisYear, chartCurrency)}</span>
        </div>
        <div className="px-5 pt-4 pb-3">
          <RevenueChart months={months} currency={chartCurrency} />
        </div>
      </div>

      {/* Bottom two panels */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recently paid */}
        <div className="lg:col-span-2 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700">
          <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
            <span className="font-medium text-sm">Recently Paid</span>
            <Link href="/invoices?status=paid" className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300">View all →</Link>
          </div>
          <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {recentPaid.length === 0 && (
              <p className="px-5 py-8 text-sm text-neutral-400 dark:text-neutral-500 text-center">No paid invoices yet.</p>
            )}
            {recentPaid.map((inv) => {
              const totals = calcTotals(inv.document_items ?? [], inv.payments ?? [])
              const clientName = (inv.clients as unknown as { name: string } | null)?.name
              const lastPayment = [...(inv.payments ?? [])].sort((a, b) => b.date > a.date ? 1 : -1)[0]
              return (
                <Link key={inv.id} href={`/invoices/${inv.id}`} className="flex items-center px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{inv.number}</div>
                    {clientName && <div className="text-xs text-neutral-400 dark:text-neutral-500">{clientName}</div>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-medium">{formatMoney(totals.total, inv.currency)}</div>
                    {lastPayment && (
                      <div className="text-xs text-neutral-400 dark:text-neutral-500">{lastPayment.date}</div>
                    )}
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium shrink-0 text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300">
                    Paid
                  </span>
                </Link>
              )
            })}
          </div>
        </div>

        {/* Pending quotes */}
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

      {/* Overdue alert */}
      {overdue.length > 0 && (
        <Link href="/invoices?status=overdue" className="flex items-center gap-3 px-4 py-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl text-sm text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-950/60 transition-colors">
          <AlertTriangle size={15} className="shrink-0" />
          <span>
            <strong>{overdue.length} overdue invoice{overdue.length !== 1 ? 's' : ''}</strong>
            {' '}— {formatMoney(overdueTotal)} outstanding. Send reminders or record payments.
          </span>
        </Link>
      )}
    </div>
  )
}
