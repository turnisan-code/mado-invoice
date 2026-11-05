import Link from 'next/link'
import { CheckCircle, AlertTriangle, TrendingUp, Wallet, MessageSquare } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { formatDate, formatMoney, today } from '@/lib/utils/document'
import RevenueChart, { type MonthData } from '@/components/charts/RevenueChart'
import { StatusBadge } from '@/components/lists/StatusBadge'
import { buttonVariants } from '@/components/ui/button'
import { getT } from '@/lib/i18n/server'
import { n, type DictKey } from '@/lib/i18n'
import { makePeriod, periodParams } from '@/app/(app)/reports/period'
import ApplyCreditNotesButton from '@/components/layout/ApplyCreditNotesButton'
import { clientDisplayName as clientName } from '@/lib/utils/clients'
import { dashboardInvoiceTotals as docTotals, loadDashboardFigures } from '@/lib/services/reports'

const card = 'bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { t, lang } = await getT()

  const now = today()
  const {
    thisMonth, thisYear, overdue, overdueTotal, outstanding, outstandingCount, oldestOverdueDays,
    revenueThisMonth, paidThisMonthCount, momDelta, revenueThisYear, recentPaid, chartTotal,
    pendingQuotes: quotes, responses, unapplied, unarchived, unarchivedCount,
    months: monthFigures,
  } = await loadDashboardFigures(supabase, now)

  // Last 12 months bar chart from payment dates
  const monthLabels = t('dashboard.months').split(',')
  const months: MonthData[] = monthFigures.map(m => ({
    label: monthLabels[Number(m.yearMonth.slice(5, 7)) - 1],
    yearMonth: m.yearMonth,
    revenue: m.revenue,
    current: m.current,
  }))

  const year = Number(thisYear)
  const monthReport = `/reports?${periodParams(makePeriod('month', year, Number(thisMonth.slice(5, 7))))}`
  const yearReport = `/reports?${periodParams(makePeriod('year', year, 0))}`

  const stats = [
    {
      label: t('dashboard.outstanding'),
      value: outstandingCount,
      amount: outstanding,
      sub: overdue.length > 0 ? t('dashboard.overdueCount', { count: overdue.length }) : null,
      subColor: overdue.length > 0 ? 'text-red-500' : undefined,
      icon: Wallet,
      color: 'text-amber-600 bg-amber-50 dark:bg-amber-950',
      href: '/invoices?status=outstanding',
    },
    {
      label: t('dashboard.overdue'),
      value: overdue.length,
      amount: overdueTotal,
      sub: oldestOverdueDays != null ? t('dashboard.oldest', { days: oldestOverdueDays }) : null,
      subColor: undefined,
      icon: AlertTriangle,
      color: 'text-red-600 bg-red-50 dark:bg-red-950',
      href: '/invoices?status=overdue',
    },
    {
      label: t('dashboard.paidThisMonth'),
      value: paidThisMonthCount,
      amount: revenueThisMonth,
      sub: momDelta != null ? t('dashboard.vsLastMonth', { delta: `${momDelta >= 0 ? '+' : ''}${momDelta}` }) : null,
      subColor: undefined,
      icon: CheckCircle,
      color: 'text-green-600 bg-green-50 dark:bg-green-950',
      href: monthReport,
    },
    {
      label: t('dashboard.revenueYear', { year: thisYear }),
      value: null,
      amount: revenueThisYear,
      sub: null,
      subColor: undefined,
      icon: TrendingUp,
      color: 'text-purple-600 bg-purple-50 dark:bg-purple-950',
      href: yearReport,
    },
  ]

  const statusLabel = (status: string) => t(`status.${status}` as DictKey)

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">{t('dashboard.title')}</h1>
        <div className="flex gap-2">
          <Link href="/quotes/new" className={buttonVariants({ variant: 'outline' })}>
            {t('dashboard.newQuote')}
          </Link>
          <Link href="/invoices/new" className={buttonVariants()}>
            {t('dashboard.newInvoice')}
          </Link>
        </div>
      </div>

      {/* The most actionable warning first */}
      {overdue.length > 0 && (
        <Link href="/invoices?status=overdue" className="flex items-center gap-3 px-4 py-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl text-sm text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-950/60 transition-colors">
          <AlertTriangle size={15} className="shrink-0" />
          <span>
            <strong>{n(overdue.length, t('dashboard.overdueAlertOne', { count: overdue.length }), t('dashboard.overdueAlertOther', { count: overdue.length }))}</strong>
            {' '}{t('dashboard.overdueAlertTail', { amount: formatMoney(overdueTotal) })}
          </span>
        </Link>
      )}

      {(unarchivedCount ?? 0) > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1 min-w-0">
            <strong>{n(unarchivedCount ?? 0, t('books.dashboard.noArchiveOne', { count: unarchivedCount ?? 0 }), t('books.dashboard.noArchiveOther', { count: unarchivedCount ?? 0 }))}</strong>
            {' '}{t('books.dashboard.noArchiveHint')}{' '}
            {(unarchived ?? []).map((d, i) => (
              <span key={d.id}>
                {i > 0 && ', '}
                <Link href={`/${d.type === 'credit_note' ? 'credit-notes' : 'invoices'}/${d.id}`} className="underline underline-offset-2 font-medium">{d.number}</Link>
              </span>
            ))}
            {(unarchivedCount ?? 0) > (unarchived?.length ?? 0) && ' …'}
          </span>
        </div>
      )}

      {unapplied.length > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl text-sm text-amber-800 dark:text-amber-300 flex-wrap sm:flex-nowrap">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1 min-w-0">
            <strong>{n(unapplied.length, t('lifecycle.credit.unappliedOne', { count: unapplied.length }), t('lifecycle.credit.unappliedOther', { count: unapplied.length }))}</strong>
            {' '}{t('lifecycle.credit.unappliedHint')}
          </span>
          <ApplyCreditNotesButton />
        </div>
      )}

      {responses.length > 0 && (
        <div className={`${card} overflow-hidden`}>
          <div className="px-5 py-3 border-b border-neutral-100 dark:border-neutral-800 flex items-center gap-2">
            <MessageSquare size={14} className="text-blue-600 dark:text-blue-400" aria-hidden="true" />
            <span className="font-medium text-sm">{t('lifecycle.responses.title')}</span>
          </div>
          <ul className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {responses.map(r => {
              const accepted = r.detail?.action === 'accepted'
              const vars = { client: clientName(r.documents.clients) || '—', number: r.documents.number ?? '' }
              return (
                <li key={r.id}>
                  <Link href={`/quotes/${r.documents.id}`} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
                    <span className="flex-1 min-w-0 truncate">{t(accepted ? 'lifecycle.responses.accepted' : 'lifecycle.responses.rejected', vars)}</span>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0">{formatDate(r.created_at, lang)}</span>
                    <StatusBadge status={accepted ? 'accepted' : 'rejected'} label={statusLabel(accepted ? 'accepted' : 'rejected')} className="shrink-0" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(({ label, value, amount, sub, subColor, icon: Icon, color, href }) => (
          <Link key={label} href={href} className={`${card} p-4 space-y-3 hover:border-neutral-300 dark:hover:border-neutral-600 transition-colors block`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-neutral-500 dark:text-neutral-400">{label}</span>
              <span className={`p-1.5 rounded-md shrink-0 ${color}`}><Icon size={14} /></span>
            </div>
            <div>
              {value !== null && <div className="text-2xl font-semibold">{value}</div>}
              <div className={value !== null ? 'text-sm text-neutral-500 dark:text-neutral-400' : 'text-2xl font-semibold'}>{formatMoney(amount)}</div>
              {sub && <div className={`text-xs mt-0.5 ${subColor ?? 'text-neutral-500 dark:text-neutral-400'}`}>{sub}</div>}
            </div>
          </Link>
        ))}
      </div>

      {/* Revenue chart */}
      <div className={card}>
        <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between gap-3">
          <div>
            <span className="font-medium text-sm">{t('dashboard.monthlyRevenue')}</span>
            <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">{t('dashboard.last12Months')}</span>
          </div>
          <span className="text-sm font-semibold">{formatMoney(chartTotal)}</span>
        </div>
        <div className="px-5 pt-4 pb-3">
          <RevenueChart months={months} currency="EUR" label={`${t('dashboard.monthlyRevenue')} (${t('dashboard.last12Months')})`} />
        </div>
      </div>

      {/* Bottom two panels */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recently paid */}
        <div className={`lg:col-span-2 ${card}`}>
          <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
            <span className="font-medium text-sm">{t('dashboard.recentlyPaid')}</span>
            <Link href="/invoices?status=paid" className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300">{t('common.viewAll')}</Link>
          </div>
          <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {recentPaid.length === 0 && (
              <p className="px-5 py-8 text-sm text-neutral-500 dark:text-neutral-400 text-center">{t('dashboard.noPaidInvoices')}</p>
            )}
            {recentPaid.map(({ doc, paidOn }) => (
              <Link key={doc.id} href={`/invoices/${doc.id}`} className="flex items-center px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{doc.number}</div>
                  {clientName(doc.clients) && <div className="text-xs text-neutral-500 dark:text-neutral-400 truncate">{clientName(doc.clients)}</div>}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-medium">{formatMoney(docTotals(doc).total, doc.currency)}</div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">{formatDate(paidOn, lang)}</div>
                </div>
                <StatusBadge status="paid" label={t('status.paid')} className="shrink-0" />
              </Link>
            ))}
          </div>
        </div>

        {/* Pending quotes: sent and waiting for an answer */}
        <div className={card}>
          <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
            <span className="font-medium text-sm">{t('dashboard.pendingQuotes')}</span>
            <Link href="/quotes?status=sent" className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300">{t('common.viewAll')}</Link>
          </div>
          <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {(quotes?.length ?? 0) === 0 && (
              <p className="px-5 py-8 text-sm text-neutral-500 dark:text-neutral-400 text-center">{t('dashboard.noPendingQuotes')}</p>
            )}
            {quotes?.map(q => {
              const name = clientName(q.clients)
              const expired = !!q.due_date && q.due_date < now
              return (
                <Link key={q.id} href={`/quotes/${q.id}`} className="flex items-center px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{q.number}</div>
                    {name && <div className="text-xs text-neutral-500 dark:text-neutral-400 truncate">{name}</div>}
                  </div>
                  {expired
                    ? <StatusBadge status="expired" label={t('status.expired')} className="shrink-0" />
                    : <StatusBadge status="sent" label={statusLabel('sent')} className="shrink-0" />}
                </Link>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
