'use client'

// The „Kontoauszug“ page (decision D5: one import for the whole file). The statement is read once
// (StatementFile); „Einnahmen“ records the invoices' payments (BankImport, as before) and books
// the credits that pay no invoice („Andere Gutschriften“); „Ausgaben“ books the debits. The lines
// of an easybank statement are stored in Mado (decision D6), so a debit not booked today is still
// here tomorrow, without the file.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Loader2 } from 'lucide-react'
import BankImport, { type LoadedStatement } from './BankImport'
import StatementFile from './StatementFile'
import ExpenseLines from './ExpenseLines'
import { matchTransactions, preTicked, type OpenInvoice } from '@/lib/bank/match'
import { useT } from '@/lib/i18n/client'
import { apiErrorMessage } from '@/lib/api-errors'
import { formatDate } from '@/lib/utils/document'
import type { StatementView } from '@/lib/expenses/statement'
import type { ExpenseOwner } from '@/lib/expenses/owner'

interface Props {
  invoices: OpenInvoice[]
  importedRefs: string[]
  bookamatConfigured: boolean
  otherPrefixes: string[]
  closedInvoices: { id: string; number: string }[]
  owner: ExpenseOwner
}

type Tab = 'income' | 'expenses'

export default function StatementPage({ invoices, importedRefs, bookamatConfigured, otherPrefixes, closedInvoices, owner }: Props) {
  const { t, lang } = useT()
  const [statement, setStatement] = useState<LoadedStatement | null>(null)
  // A new file or none: a new epoch, never one an earlier answer had (a column mapping keeps it)
  const [epoch, setEpoch] = useState(0)
  const [tab, setTab] = useState<Tab>('income')

  const onStatement = useCallback((next: LoadedStatement | null) => {
    setStatement(next)
    setEpoch(e => e + 1)
  }, [])
  const onRemap = useCallback((next: LoadedStatement) => setStatement(next), [])

  // The lines of an easybank statement, stored and analysed; without a file, the debits still
  // open. Read again after every change the lines' editor makes (`reloads`); the editor waits
  // for the new lines.
  const [reloads, setReloads] = useState(0)
  const key = `${epoch}:${reloads}`
  const [loaded, setLoaded] = useState<{ epoch: number; view: StatementView | null } | null>(null)
  const [answered, setAnswered] = useState<{ key: string; error: string | null } | null>(null)
  const waiters = useRef<(() => void)[]>([])
  const reload = useCallback(() => new Promise<void>(resolve => {
    waiters.current.push(resolve)
    setReloads(r => r + 1)
  }), [])

  useEffect(() => {
    if (!bookamatConfigured) return
    let active = true
    const lines = statement?.parsed.format === 'easybank'
      ? statement.parsed.transactions.filter(tx => tx.cells?.length).map(tx => ({ key: tx.id, cells: tx.cells! }))
      : null
    const request: Promise<{ view: StatementView | null } | { error: string }> = statement && !lines?.length
      ? Promise.resolve({ view: null })
      : fetch('/api/bank-lines', lines
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }) }
        : { method: 'GET' })
        .then(async res => (res.ok
          ? { view: await res.json() as StatementView }
          : { error: apiErrorMessage(t, await res.json().catch(() => ({}))) }))
        .catch(() => ({ error: t('messages.network') }))
    void request.then(r => {
      if (!active) return
      if ('error' in r) setAnswered({ key, error: r.error })
      else {
        setLoaded({ epoch, view: r.view })
        setAnswered({ key, error: null })
      }
      const done = waiters.current
      waiters.current = []
      for (const resolve of done) resolve()
    })
    return () => { active = false }
  }, [key, epoch, statement, bookamatConfigured, t])

  // The lines of this file (or of none): a reload keeps them shown until the new ones are there
  const view = loaded && loaded.epoch === epoch ? loaded.view : null
  const loading = bookamatConfigured && answered?.key !== key
  const error = answered?.key === key ? answered.error : null

  // Which credits pay an invoice: those the „Einnahmen“ matcher ticks, or that name an invoice
  // already paid, are not „Andere Gutschriften“. One it only suggests for an invoice is listed with
  // the suggestion; with no invoice open every credit is.
  const credits = useMemo(() => {
    if (!statement) return null
    const rows = matchTransactions(statement.parsed.transactions, invoices, new Set(importedRefs), { otherPrefixes, closed: closedInvoices })
    const other = new Set<string>()
    const hints: Record<string, string> = {}
    for (const r of rows) {
      if (r.status === 'nothing_open' || (r.status === 'unmatched' && !r.names)) other.add(r.transaction.id)
      else if (r.status === 'match' && !preTicked(r)) {
        other.add(r.transaction.id)
        hints[r.transaction.id] = t('statement.suggestedHint', { number: invoices.find(i => i.id === r.invoiceId)?.number ?? '' })
      }
    }
    return { other, hints }
  }, [statement, invoices, importedRefs, otherPrefixes, closedInvoices, t])

  const debits = (view?.lines ?? []).filter(v => v.kind === 'expense')
  const otherCredits = (view?.lines ?? []).filter(v => v.kind === 'bank_income' && !v.invoicePayment && (credits?.other.has(v.line.line_key) ?? false))
  const openDebits = debits.filter(v => v.line.status === 'open').length
  const easybank = !statement || statement.parsed.format === 'easybank'

  const tabButton = (k: Tab, label: string, count?: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === k}
      onClick={() => setTab(k)}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === k ? 'border-blue-500 text-neutral-900 dark:text-neutral-100' : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'}`}
    >
      {label}{count ? <span className="ml-1.5 text-xs text-neutral-400">{count}</span> : null}
    </button>
  )

  // What stands above the lines: why there are none to book, or what keeps them from being booked
  const state = () => {
    if (!bookamatConfigured) return <p className="text-sm text-neutral-500 dark:text-neutral-400 px-4 sm:px-6 py-4">{t('expenses.notConfigured')}</p>
    if (!easybank) return <p className="text-sm text-neutral-500 dark:text-neutral-400 px-4 sm:px-6 py-4">{t('expenses.easybankOnly')}</p>
    if (error && !view) return <p className="flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400 px-4 sm:px-6 py-4"><AlertTriangle size={14} /> {error}</p>
    if (loading && !view) return <p className="flex items-center gap-2 text-sm text-neutral-500 px-4 sm:px-6 py-4"><Loader2 size={14} className="animate-spin" /> {t('expenses.loading')}</p>
    return null
  }
  const banner = view && (
    <>
      {error && <p className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 px-4 sm:px-6 pb-2"><AlertTriangle size={13} /> {t('statement.reloadFailed', { error })}</p>}
      {!view.switchFrom && (
        <p className="mx-4 sm:mx-6 mb-3 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {t('statement.switchMissing')} <Link href="/settings/rules" className="underline underline-offset-2">{t('statement.rulesLink')}</Link>
        </p>
      )}
      {view.switchFrom && <p className="text-xs text-neutral-500 dark:text-neutral-400 px-4 sm:px-6 pb-2">{t('statement.switchFrom', { date: formatDate(view.switchFrom, lang) })}</p>}
    </>
  )

  return (
    <div className="space-y-4">
      <StatementFile statement={statement} onStatement={onStatement} />

      <div role="tablist" className="flex gap-1 border-b border-neutral-200 dark:border-neutral-700">
        {tabButton('income', t('statement.tabIncome'))}
        {tabButton('expenses', t('statement.tabExpenses'), openDebits)}
      </div>

      <div hidden={tab !== 'income'} className="space-y-4">
        <BankImport
          key={epoch}
          statement={statement}
          onStatement={onStatement}
          onRemap={onRemap}
          invoices={invoices}
          importedRefs={importedRefs}
          bookamatConfigured={bookamatConfigured}
          otherPrefixes={otherPrefixes}
          closedInvoices={closedInvoices}
        />
        {statement && easybank && bookamatConfigured && (
          <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
            <div className="p-4 sm:p-6 pb-3 sm:pb-3">
              <h2 className="text-sm font-semibold">{t('statement.otherCreditsTitle')}</h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('statement.otherCreditsHint')}</p>
            </div>
            {state() ?? (view && (
              <>
                {banner}
                <ExpenseLines kind="bank_income" lines={otherCredits} accounts={view.accounts} accountsErrors={view.accountsErrors} owner={owner} hints={credits?.hints} onChanged={reload} />
              </>
            ))}
          </section>
        )}
      </div>

      <div hidden={tab !== 'expenses'}>
        <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          <div className="p-4 sm:p-6 pb-3 sm:pb-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold">{t('statement.expensesTitle')}</h2>
              <Link href="/settings/rules" className="text-xs underline underline-offset-2 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200">{t('statement.rulesLink')}</Link>
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t(statement ? 'statement.expensesHint' : 'statement.expensesOpenHint')}</p>
            {view && view.unreadable > 0 && <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">{t('statement.unreadable', { count: view.unreadable })}</p>}
          </div>
          {state() ?? (view && (
            <>
              {banner}
              <ExpenseLines kind="expense" lines={debits} accounts={view.accounts} accountsErrors={view.accountsErrors} owner={owner} onChanged={reload} />
            </>
          ))}
        </section>
      </div>
    </div>
  )
}
