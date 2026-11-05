import Link from 'next/link'
import { CheckCircle, AlertTriangle, TrendingUp, Wallet, MessageSquare } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { calcTotals, formatDate, formatMoney, roundCents, today } from '@/lib/utils/document'
import RevenueChart, { type MonthData } from '@/components/charts/RevenueChart'
import { StatusBadge } from '@/components/lists/StatusBadge'
import { getT } from '@/lib/i18n/server'
import { n, type DictKey } from '@/lib/i18n'
import { makePeriod, periodParams } from '@/app/(app)/reports/period'
import { unappliedCreditNotes } from '@/lib/credits'
import ApplyCreditNotesButton from '@/components/layout/ApplyCreditNotesButton'
import { clientDisplayName as clientName } from '@/lib/utils/clients'

// Month keys come from the Vienna calendar date and are shifted in UTC, so neither the server's
// time zone nor a 31st (setMonth overflow) can move a payment into the wrong month.
function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

type ClientRef = { name: string; company: string | null } | null
type DocItems = Parameters<typeof calcTotals>[0]
type InvoiceRow = {
  id: string
  number: string | null
  status: string
  due_date: string | null
  currency: string
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  clients: ClientRef
  document_items: DocItems
  payments: { amount: number; kind?: string | null }[]
}

const card = 'bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { t, lang } = await getT()

  const now = today()
  const thisMonth = now.slice(0, 7)
  const thisYear = now.slice(0, 4)
  const lastMonth = shiftMonth(thisMonth, -1)
  const chartMonths = Array.from({ length: 12 }, (_, i) => shiftMonth(thisMonth, i - 11))
  // The earliest month any figure needs: the chart window, last month or 1 January.
  const since = `${[chartMonths[0], lastMonth, `${thisYear}-01`].sort()[0]}-01`

  const items = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'
  const invoiceCols = `id, number, status, due_date, currency, tax_treatment, discount_type, discount_value, clients(name, company), ${items}, payments(amount, kind)`

  const [{ data: activeInvoices }, { data: received }, { data: refundRows }, { data: paidPayments }, { data: quotes }, { data: responseEvents }, unapplied, { data: unarchived, count: unarchivedCount }] = await Promise.all([
    supabase.from('documents').select(invoiceCols).eq('type', 'invoice').in('status', ['sent', 'overdue']),
    // Revenue is cash-based (Ist-Besteuerung): every money payment counts on the day it arrived,
    // whatever the invoice status; Skonto and write-offs close invoices without revenue.
    supabase.from('payments').select('amount, date, document_id, documents!inner(type)').eq('documents.type', 'invoice').eq('kind', 'payment').gte('date', since),
    // Money paid back on credit notes leaves again on the day it was paid.
    supabase.from('payments').select('amount, date').eq('kind', 'refund').gte('date', since),
    // Recently paid = the invoices whose latest payment is newest, not the newest invoices.
    supabase
      .from('payments')
      .select(`id, date, document_id, documents!inner(type, ${invoiceCols})`)
      .eq('documents.type', 'invoice')
      .eq('documents.status', 'paid')
      // An applied credit note is no money received and fees come on top; neither dates a payment here.
      .in('kind', ['payment', 'skonto', 'writeoff'])
      .order('date', { ascending: false })
      .order('id', { ascending: false })
      .limit(40),
    supabase.from('documents').select('id, number, date, due_date, clients(name, company)').eq('type', 'quote').eq('status', 'sent').order('date', { ascending: false }).limit(5),
    // Client answers in the portal stay here until the owner opens the quote.
    supabase
      .from('document_events')
      .select('id, created_at, detail, documents!inner(id, number, clients(name, company))')
      .eq('type', 'portal_responded')
      .is('read_at', null)
      .order('created_at', { ascending: false })
      .limit(10),
    // Credit notes that should already have reduced their invoice's balance.
    unappliedCreditNotes(supabase).catch(err => {
      console.error('[dashboard] unapplied credit notes:', err)
      return []
    }),
    // Issued documents whose frozen PDF (the archive copy) was never stored.
    supabase
      .from('documents')
      .select('id, type, number', { count: 'exact' })
      .in('type', ['invoice', 'credit_note'])
      .not('number', 'is', null)
      .is('pdf_path', null)
      .order('date', { ascending: false })
      .limit(5),
  ])
  const responses = (responseEvents ?? []) as unknown as { id: string; created_at: string; detail: { action?: string }; documents: { id: string; number: string | null; clients: ClientRef } }[]

  const active = (activeInvoices ?? []) as unknown as InvoiceRow[]
  const payments = (received ?? []) as unknown as { amount: number; date: string; document_id: string }[]
  // Revenue is money received less money paid back.
  const moneyRows = [...payments, ...((refundRows ?? []) as { amount: number; date: string }[]).map(r => ({ amount: -r.amount, date: r.date }))]

  const docTotals = (doc: InvoiceRow) => calcTotals(
    doc.document_items ?? [],
    doc.payments ?? [],
    doc.discount_type && doc.discount_value ? { type: doc.discount_type as 'percent' | 'fixed', value: doc.discount_value } : null,
    doc.tax_treatment,
  )

  const open = active.filter(i => i.status === 'sent' && (i.due_date ?? '9999') >= now)
  const overdue = active.filter(i => i.status === 'overdue' || (i.status === 'sent' && i.due_date && i.due_date < now))

  // Outstanding money is what is still unpaid, not the invoice totals
  const overdueTotal = roundCents(overdue.reduce((s, d) => s + docTotals(d).balance_due, 0))
  const openTotal = roundCents(open.reduce((s, d) => s + docTotals(d).balance_due, 0))
  const outstanding = roundCents(overdueTotal + openTotal)
  const outstandingCount = open.length + overdue.length

  const withDueDate = overdue.filter(i => i.due_date)
  const oldestOverdueDays = withDueDate.length
    ? Math.max(...withDueDate.map(i => Math.floor((new Date(now).getTime() - new Date(i.due_date!).getTime()) / 86400000)))
    : null

  const inMonth = (m: string) => moneyRows.filter(p => p.date?.startsWith(m))
  const sum = (ps: { amount: number }[]) => roundCents(ps.reduce((s, p) => s + p.amount, 0))
  const revenueThisMonth = sum(inMonth(thisMonth))
  const revenueLastMonth = sum(inMonth(lastMonth))
  const paidThisMonthCount = new Set(payments.filter(p => p.date?.startsWith(thisMonth)).map(p => p.document_id)).size
  const momDelta = revenueLastMonth > 0
    ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
    : null
  const revenueThisYear = sum(moneyRows.filter(p => p.date?.startsWith(thisYear)))

  const recentPaid: { doc: InvoiceRow; paidOn: string }[] = []
  const seen = new Set<string>()
  for (const p of (paidPayments ?? []) as unknown as { date: string; document_id: string; documents: InvoiceRow }[]) {
    if (seen.has(p.document_id)) continue
    seen.add(p.document_id)
    recentPaid.push({ doc: p.documents, paidOn: p.date })
    if (recentPaid.length === 6) break
  }

  // Last 12 months bar chart from payment dates
  const monthLabels = t('dashboard.months').split(',')
  const months: MonthData[] = chartMonths.map(key => ({
    label: monthLabels[Number(key.slice(5, 7)) - 1],
    yearMonth: key,
    revenue: sum(inMonth(key)),
    current: key === thisMonth,
  }))
  const chartTotal = sum(months.map(m => ({ amount: m.revenue })))

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
          <Link href="/quotes/new" className="text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
            {t('dashboard.newQuote')}
          </Link>
          <Link href="/invoices/new" className="text-sm px-3 py-2 rounded-lg bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors">
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
              const name = clientName(q.clients as unknown as ClientRef)
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
