'use client'

// The „Kontoauszug“ page (decision D5: one import for the whole file). The statement is read once
// (StatementFile); „Einnahmen“ records the invoices' payments (BankImport, as before) and books
// the credits that pay no invoice („Andere Gutschriften“); „Ausgaben“ books the debits. The lines
// of an easybank statement are stored in Mado (decision D6), so a debit not booked today is still
// here tomorrow, without the file.
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Loader2 } from 'lucide-react'
import BankImport, { type LoadedStatement } from './BankImport'
import StatementFile from './StatementFile'
import ExpenseLines from './ExpenseLines'
import { matchTransactions, type OpenInvoice } from '@/lib/bank/match'
import { useT } from '@/lib/i18n/client'
import { apiErrorMessage } from '@/lib/api-errors'
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
  const { t } = useT()
  const [statement, setStatement] = useState<(LoadedStatement & { version: number }) | null>(null)
  const [tab, setTab] = useState<Tab>('income')

  const onStatement = useCallback((next: LoadedStatement | null) => {
    setStatement(prev => (next ? { ...next, version: (prev?.version ?? 0) + 1 } : null))
  }, [])
  // The lines of an easybank statement, stored and analysed; without a file, the lines still
  // open. Read again after every change the lines' editor makes (`reloads`).
  const [reloads, setReloads] = useState(0)
  const key = `${statement?.version ?? 0}:${reloads}`
  const [answer, setAnswer] = useState<{ key: string; view: StatementView | null; error: string | null } | null>(null)
  const reload = useCallback(() => setReloads(r => r + 1), [])

  useEffect(() => {
    if (!bookamatConfigured) return
    let active = true
    const lines = statement?.parsed.format === 'easybank'
      ? statement.parsed.transactions.filter(tx => tx.cells?.length).map(tx => ({ key: tx.id, cells: tx.cells! }))
      : null
    const request = statement && !lines?.length
      ? Promise.resolve({ view: null, error: null })
      : fetch('/api/bank-lines', lines
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }) }
        : { method: 'GET' })
        .then(async res => (res.ok
          ? { view: await res.json() as StatementView, error: null }
          : { view: null, error: apiErrorMessage(t, await res.json().catch(() => ({}))) }))
        .catch(() => ({ view: null, error: t('messages.network') }))
    void request.then(r => { if (active) setAnswer({ key, ...r }) })
    return () => { active = false }
  }, [key, statement, bookamatConfigured, t])

  const loading = bookamatConfigured && answer?.key !== key
  // While a reload runs, the lines stay as they were
  const view = answer?.view ?? null
  const error = answer?.key === key ? answer.error : null

  // Which credits pay an invoice: those the „Einnahmen“ matcher matches, or that name an invoice
  // already paid, are not „Andere Gutschriften“
  const otherCredits = useMemo(() => {
    if (!statement) return null
    const rows = matchTransactions(statement.parsed.transactions, invoices, new Set(importedRefs), { otherPrefixes, closed: closedInvoices })
    return new Set(rows.filter(r => r.status === 'unmatched' && !r.names).map(r => r.transaction.id))
  }, [statement, invoices, importedRefs, otherPrefixes, closedInvoices])

  const debits = (view?.lines ?? []).filter(v => v.kind === 'expense')
  const credits = (view?.lines ?? []).filter(v => v.kind === 'bank_income' && !v.invoicePayment && (otherCredits?.has(v.line.line_key) ?? false))
  const openDebits = debits.filter(v => v.line.status === 'open').length
  const easybank = !statement || statement.parsed.format === 'easybank'

  const tabButton = (key: Tab, label: string, count?: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === key}
      onClick={() => setTab(key)}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === key ? 'border-blue-500 text-neutral-900 dark:text-neutral-100' : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'}`}
    >
      {label}{count ? <span className="ml-1.5 text-xs text-neutral-400">{count}</span> : null}
    </button>
  )

  const expensesBody = () => {
    if (!bookamatConfigured) return <p className="text-sm text-neutral-500 dark:text-neutral-400 px-4 sm:px-6 py-4">{t('expenses.notConfigured')}</p>
    if (!easybank) return <p className="text-sm text-neutral-500 dark:text-neutral-400 px-4 sm:px-6 py-4">{t('expenses.easybankOnly')}</p>
    if (error) return <p className="flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400 px-4 sm:px-6 py-4"><AlertTriangle size={14} /> {error}</p>
    if (loading && !view) return <p className="flex items-center gap-2 text-sm text-neutral-500 px-4 sm:px-6 py-4"><Loader2 size={14} className="animate-spin" /> {t('expenses.loading')}</p>
    return null
  }

  return (
    <div className="space-y-4">
      <StatementFile statement={statement} onStatement={onStatement} />

      <div role="tablist" className="flex gap-1 border-b border-neutral-200 dark:border-neutral-700">
        {tabButton('income', t('statement.tabIncome'))}
        {tabButton('expenses', t('statement.tabExpenses'), openDebits)}
      </div>

      <div hidden={tab !== 'income'} className="space-y-4">
        <BankImport
          key={statement?.version ?? 0}
          statement={statement}
          onStatement={onStatement}
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
            {expensesBody() ?? (view && (
              <ExpenseLines kind="bank_income" lines={credits} accounts={view.accounts} accountsErrors={view.accountsErrors} owner={owner} onChanged={reload} />
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
          {expensesBody() ?? (view && (
            <ExpenseLines kind="expense" lines={debits} accounts={view.accounts} accountsErrors={view.accountsErrors} owner={owner} onChanged={reload} />
          ))}
        </section>
      </div>
    </div>
  )
}
