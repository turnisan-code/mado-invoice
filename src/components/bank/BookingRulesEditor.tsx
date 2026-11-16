'use client'

// Einstellungen → „Buchungsregeln“ (PR 9a): the rules that book a recurring debit on their own —
// recognised by a keyword in the bank text (and an amount range or, with 9b, the invoice address
// on the Beleg), booked on the accounts named here. Accounts are chosen by their Bookamat title
// and looked up in each year's books (decision D7), so nothing is picked again in January.
// Also the owner's other business accounts: a transfer to or from one is no Privatentnahme.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowLeft, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { createClient } from '@/lib/supabase/client'
import { useT } from '@/lib/i18n/client'
import { apiErrorMessage } from '@/lib/api-errors'
import type { BookingRule } from '@/types'
import type { BookamatAccounts } from '@/lib/expenses/types'
import { purchasePool, taxAccountSide } from '@/lib/expenses/tax-accounts'
import { ruleAccountIssues } from '@/lib/expenses/rules'
import { isIban, normIban } from '@/lib/expenses/own-transfer'
import { AT_VAT_RATES } from '@/lib/expenses/vat-origin'

type Draft = Omit<BookingRule, 'id' | 'created_at' | 'updated_at'> & { id?: string }

const EMPTY: Draft = {
  name: '', active: true, category: '', match_strings: [], email_sender: '', email_body_keywords: [],
  cost_account: '', tax_account: '', bank_account: '', tax_percent: 20, ba_amount: 100, ba_tax: 100,
  country: '', vatin: '', title_template: '{vendor} {month_short}', notes_template: '', amount_min: null, amount_max: null,
  invoice_address_match: '', skip_receipt: false,
}

const lines = (text: string) => text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)

interface Props {
  rules: BookingRule[]
  settingsId: string
  invoiceIban: string
  ownIbans: string[]
  expensesFrom: string | null
  year: number
}

export default function BookingRulesEditor({ rules, settingsId, invoiceIban, ownIbans, expensesFrom, year }: Props) {
  const { t } = useT()
  const router = useRouter()
  const [lists, setLists] = useState<BookamatAccounts | null>(null)
  const [listsError, setListsError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [remove, setRemove] = useState<BookingRule | null>(null)
  const [ibans, setIbans] = useState(ownIbans.join('\n'))
  const [switchDate, setSwitchDate] = useState(expensesFrom ?? '')

  useEffect(() => {
    let active = true
    fetch(`/api/expenses/accounts?year=${year}`)
      .then(async res => {
        const body = await res.json().catch(() => ({}))
        if (!active) return
        if (res.ok) setLists(body as BookamatAccounts)
        else setListsError(apiErrorMessage(t, body))
      })
      .catch(() => { if (active) setListsError(t('messages.network')) })
    return () => { active = false }
  }, [year, t])

  const purchaseSide = useMemo(() => (lists?.purchasetax_accounts ?? []).filter(a => taxAccountSide(a) === 'purchase'), [lists])

  async function save() {
    if (!draft) return
    setBusy(true)
    const { id, ...body } = draft
    const res = await fetch(id ? `/api/booking-rules/${id}` : '/api/booking-rules', {
      method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null)
    setBusy(false)
    if (!res?.ok) { toast.error(res ? apiErrorMessage(t, await res.json().catch(() => ({}))) : t('messages.network')); return }
    setDraft(null)
    toast.success(t('bookingRules.saved'))
    router.refresh()
  }

  async function confirmRemove() {
    if (!remove) return
    setBusy(true)
    const res = await fetch(`/api/booking-rules/${remove.id}`, { method: 'DELETE' }).catch(() => null)
    setBusy(false)
    setRemove(null)
    if (!res?.ok) { toast.error(res ? apiErrorMessage(t, await res.json().catch(() => ({}))) : t('messages.network')); return }
    router.refresh()
  }

  async function saveIbans() {
    const list = [...new Set(lines(ibans).map(normIban))]
    const bad = list.filter(i => !isIban(i))
    if (bad.length) { toast.error(t('bookingRules.ibanInvalid', { iban: bad.join(', ') })); return }
    setBusy(true)
    const { error } = await createClient().from('settings').update({ own_ibans: list }).eq('id', settingsId)
    setBusy(false)
    if (error) { toast.error(error.message); return }
    setIbans(list.join('\n'))
    toast.success(t('bookingRules.ibansSaved'))
    router.refresh()
  }

  // The switch-over (decision D2): from this bank date on Mado books the statement's lines
  async function saveSwitch() {
    if (switchDate && !/^\d{4}-\d{2}-\d{2}$/.test(switchDate)) return
    setBusy(true)
    const { error } = await createClient().from('settings').update({ expenses_from: switchDate || null }).eq('id', settingsId)
    setBusy(false)
    if (error) { toast.error(error.message); return }
    toast.success(t('bookingRules.switchSaved'))
    router.refresh()
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(d => (d ? { ...d, [key]: value } : d))
  const titleSelect = (label: string, value: string, options: { id: number; name: string }[], onChange: (v: string) => void, emptyLabel: string) => {
    const known = !value || options.some(a => a.name === value)
    return (
      <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
        <span className="block font-medium">{label}</span>
        <Select value={value} onChange={e => onChange(e.target.value)}>
          <option value="">{emptyLabel}</option>
          {!known && <option value={value}>{t('bookingRules.missingInYear', { title: value, year })}</option>}
          {options.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
        </Select>
      </label>
    )
  }
  const field = (label: string, value: string | number | null, onChange: (v: string) => void, opts: { type?: string; hint?: string } = {}) => (
    <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
      <span className="block font-medium">{label}</span>
      <Input type={opts.type ?? 'text'} value={value ?? ''} onChange={e => onChange(e.target.value)} />
      {opts.hint && <span className="block text-[11px] text-neutral-400">{opts.hint}</span>}
    </label>
  )

  function form(d: Draft) {
    const cost = lists?.cost_accounts?.find(a => a.name === d.cost_account)
    const pool = cost ? purchasePool(lists?.purchasetax_accounts, cost.purchasetaxaccounts) : purchaseSide
    const issues = ruleAccountIssues(d, lists)
    const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')))
    return (
      <section className="bg-white dark:bg-neutral-900 rounded-xl border border-blue-200 dark:border-blue-900 p-4 sm:p-6 space-y-4">
        <h2 className="text-sm font-semibold">{d.id ? t('bookingRules.editTitle') : t('bookingRules.newTitle')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {field(t('bookingRules.name'), d.name, v => set('name', v))}
          {field(t('bookingRules.category'), d.category, v => set('category', v))}
          <label className="flex items-center gap-2 text-sm pt-6">
            <input type="checkbox" checked={d.active} onChange={e => set('active', e.target.checked)} /> {t('bookingRules.active')}
          </label>
        </div>
        <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
          <span className="block font-medium">{t('bookingRules.keywords')}</span>
          <Textarea rows={2} value={d.match_strings.join('\n')} onChange={e => set('match_strings', e.target.value.split(/\r?\n/))} />
          <span className="block text-[11px] text-neutral-400">{t('bookingRules.keywordsHint')}</span>
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {titleSelect(t('bookingRules.costAccount'), d.cost_account, lists?.cost_accounts ?? [], v => set('cost_account', v), t('expenses.choose'))}
          {titleSelect(t('bookingRules.taxAccount'), d.tax_account, pool, v => set('tax_account', v), t('expenses.choose'))}
          {titleSelect(t('bookingRules.bankAccount'), d.bank_account, lists?.bank_accounts ?? [], v => set('bank_account', v), t('bookingRules.bankStatement'))}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <label className="block text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
            <span className="block font-medium">{t('expenses.rate')}</span>
            <Select value={String(d.tax_percent)} onChange={e => set('tax_percent', Number(e.target.value))}>
              {[...AT_VAT_RATES, 0].map(r => <option key={r} value={r}>{r} %</option>)}
            </Select>
          </label>
          {field(t('expenses.baAmount'), d.ba_amount, v => set('ba_amount', num(v) ?? 0), { type: 'number' })}
          {field(t('expenses.baTax'), d.ba_tax, v => set('ba_tax', num(v) ?? 0), { type: 'number', hint: t('bookingRules.baTaxHint') })}
          {field(t('expenses.country'), d.country, v => set('country', v))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field(t('expenses.vatin'), d.vatin, v => set('vatin', v))}
          {field(t('bookingRules.titleTemplate'), d.title_template, v => set('title_template', v), { hint: t('bookingRules.titleHint') })}
          {field(t('bookingRules.notesTemplate'), d.notes_template, v => set('notes_template', v))}
          <div className="grid grid-cols-2 gap-3">
            {field(t('bookingRules.amountMin'), d.amount_min, v => set('amount_min', num(v)), { type: 'number' })}
            {field(t('bookingRules.amountMax'), d.amount_max, v => set('amount_max', num(v)), { type: 'number' })}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field(t('bookingRules.emailSender'), d.email_sender, v => set('email_sender', v), { hint: t('bookingRules.gmailLater') })}
          {field(t('bookingRules.addressMatch'), d.invoice_address_match, v => set('invoice_address_match', v), { hint: t('bookingRules.gmailLater') })}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.skip_receipt} onChange={e => set('skip_receipt', e.target.checked)} /> {t('bookingRules.skipReceipt')}
        </label>
        {issues.map(i => (
          <p key={i.field} className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle size={13} /> {t(i.issue === 'missing' ? 'bookingRules.issueMissing' : 'bookingRules.issueAmbiguous', { title: i.title, year })}
          </p>
        ))}
        <div className="flex gap-2">
          <Button type="button" disabled={busy || !d.name.trim()} onClick={() => void save()}>{t('common.save')}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
        </div>
      </section>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <Link href="/settings" aria-label={t('bookingRules.back')} className="h-11 w-11 -m-3.5 mt-[-0.5rem] inline-flex items-center justify-center rounded-md text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200 shrink-0">
          <ArrowLeft size={16} />
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold">{t('bookingRules.title')}</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{t('bookingRules.intro')}</p>
        </div>
      </div>

      {listsError && <p className="flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400"><AlertTriangle size={14} /> {t('bookingRules.accountsFailed', { year, error: listsError })}</p>}

      {draft ? form(draft) : (
        <Button type="button" onClick={() => setDraft({ ...EMPTY })}><Plus size={14} /> {t('bookingRules.add')}</Button>
      )}

      <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 divide-y divide-neutral-100 dark:divide-neutral-800">
        {rules.length === 0 && <p className="px-4 sm:px-6 py-4 text-sm text-neutral-500 dark:text-neutral-400">{t('bookingRules.none')}</p>}
        {rules.map(r => {
          const issues = ruleAccountIssues(r, lists)
          return (
            <div key={r.id} className="px-4 sm:px-6 py-3 flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{r.name}{!r.active && <span className="ml-2 text-xs text-neutral-400">{t('bookingRules.inactive')}</span>}</p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {t('bookingRules.summary', { keywords: r.match_strings.join(', ') || '—', cost: r.cost_account || '—', tax: r.tax_account || '—', rate: r.tax_percent, ba: r.ba_amount, baTax: r.ba_tax })}
                  {r.amount_min !== null || r.amount_max !== null ? ` · ${t('bookingRules.range', { min: r.amount_min ?? '—', max: r.amount_max ?? '—' })}` : ''}
                  {r.skip_receipt ? ` · ${t('bookingRules.noReceipt')}` : ''}
                </p>
                {issues.map(i => (
                  <p key={i.field} className="text-[11px] text-amber-700 dark:text-amber-400">{t(i.issue === 'missing' ? 'bookingRules.issueMissing' : 'bookingRules.issueAmbiguous', { title: i.title, year })}</p>
                ))}
              </div>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setDraft({ ...r })}>{t('bookingRules.edit')}</Button>
              <button type="button" aria-label={t('common.delete')} disabled={busy} onClick={() => setRemove(r)} className="h-8 w-8 flex items-center justify-center rounded-md text-neutral-500 hover:text-red-600"><Trash2 size={14} /></button>
            </div>
          )
        })}
      </section>

      <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6 space-y-3">
        <h2 className="text-sm font-semibold">{t('bookingRules.switchTitle')}</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('bookingRules.switchHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={switchDate} onChange={e => setSwitchDate(e.target.value)} className="w-auto" />
          <Button type="button" variant="outline" disabled={busy || switchDate === (expensesFrom ?? '')} onClick={() => void saveSwitch()}>{t('common.save')}</Button>
          {!expensesFrom && <span className="text-xs text-neutral-500">{t('bookingRules.switchNone')}</span>}
        </div>
      </section>

      <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6 space-y-3">
        <h2 className="text-sm font-semibold">{t('bookingRules.ibansTitle')}</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('bookingRules.ibansHint', { iban: invoiceIban || '—' })}</p>
        <Textarea rows={3} value={ibans} onChange={e => setIbans(e.target.value)} placeholder="AT.. .... .... .... ...." />
        <Button type="button" variant="outline" disabled={busy} onClick={() => void saveIbans()}>{t('common.save')}</Button>
      </section>

      <ConfirmDialog
        open={!!remove}
        title={t('bookingRules.deleteTitle')}
        description={remove ? t('bookingRules.deleteText', { name: remove.name }) : ''}
        confirmLabel={t('common.delete')}
        destructive
        busy={busy}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemove(null)}
      />
    </div>
  )
}
