'use client'

import { useState, useEffect, useId, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { StatusBadge, STATUS_TEXT } from '@/components/lists/StatusBadge'
import { inputClass } from '@/components/lists/ListParts'
import { toastApiError } from '@/lib/google/toast'
import { apiErrorMessage, requestErrorMessage } from '@/lib/api-errors'
import { logEvent } from '@/lib/events'
import { flushPendingEdits } from '@/lib/issued-pdf'
import { addDays, calcTotals, formatMoney, today } from '@/lib/utils/document'
import { asDbError, displayStatus, lifecycleErrorMessage, statusLabelKey, statusMenuTargets } from '@/lib/status'
import { useT } from '@/lib/i18n/client'
import type { DictKey } from '@/lib/i18n'
import type { DisplayStatus, DocumentStatus, DocumentType, IssueProblem, PaymentKind, PaymentMethod, Settings } from '@/types'
import { IssueDialog } from '@/components/forms/builder/IssueDialog'
import ProjectLinkWarning from '@/components/projects/ProjectLinkWarning'
import { isIssueProblems } from '@/components/forms/builder/IssueProblems'
import { applyIssueDateInEditor } from '@/components/forms/builder/events'
import { expectedNumber, termDays, type NumberingSettings } from '@/components/forms/builder/model'

const DESTRUCTIVE = new Set(['cancelled', 'rejected'])

type CalcItems = Parameters<typeof calcTotals>[0]

// What the issue dialog needs, read from the stored draft once its pending edits are written.
type IssuePrep = {
  status: string
  draftDate: string
  staleDate: string | null
  // The due date a stale invoice or quote gets when it is issued with today's date (as in the editor).
  todayDue: string
  latestIssued: { number: string; date: string } | null
  numbering: Partial<NumberingSettings>
  zeroTotal: string | null
  problems: IssueProblem[] | null
}

interface Props {
  document: {
    id: string
    status: string
    type: string
    number: string | null
    due_date?: string | null
    tax_treatment?: string | null
    discount_type?: string | null
    discount_value?: number | null
    document_items?: CalcItems | null
    payments?: { amount: number; kind?: PaymentKind | string | null }[] | null
  }
  /** A state the page derived itself (a settled credit note); otherwise derived here. */
  display?: DisplayStatus
}

export default function DocumentStatusBar({ document: doc, display }: Props) {
  const [status, setStatus] = useState(doc.status)
  const [seenStatus, setSeenStatus] = useState(doc.status)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [paidDate, setPaidDate] = useState('')
  const [paidMethod, setPaidMethod] = useState<PaymentMethod>('bank')
  const [paidDateInvalid, setPaidDateInvalid] = useState(false)
  const [stornoReason, setStornoReason] = useState('')
  const [issue, setIssue] = useState<IssuePrep | null>(null)
  const busyRef = useRef(false)
  const ref = useRef<HTMLDivElement>(null)
  const uid = useId()
  const router = useRouter()
  const supabase = createClient()
  const { t } = useT()
  const type = doc.type as DocumentType
  const todayStr = today()
  const targets = statusMenuTargets({ type, status: status as DocumentStatus })
  const statusLabel = (s: string) => t(statusLabelKey(s))

  if (doc.status !== seenStatus) {
    setSeenStatus(doc.status)
    setStatus(doc.status)
  }

  const shown: DisplayStatus = status !== doc.status ? status as DocumentStatus : display ?? displayStatus({
    type,
    status,
    due_date: doc.due_date ?? null,
    total: doc.document_items ? calcTotals(
      doc.document_items,
      [],
      doc.discount_type && doc.discount_value ? { type: doc.discount_type as 'percent' | 'fixed', value: doc.discount_value } : null,
      doc.tax_treatment,
    ).total : undefined,
    payments: doc.payments ?? undefined,
  }, todayStr)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Every status beyond draft/cancelled means the document has been issued, which requires a number.
  const needsNumber = (s: string) => !doc.number && s !== 'draft' && s !== 'cancelled'
  // "Paid" on an invoice goes through the server, which records the open balance as a payment
  // on the date and by the method confirmed here.
  const recordsPayment = (s: string) => s === 'paid' && type === 'invoice'
  // An issued invoice is cancelled with a Storno document, never by just flipping the status.
  const createsStorno = (s: string) => s === 'cancelled' && type === 'invoice' && !!doc.number

  function changeStatus(newStatus: string) {
    setOpen(false)
    if (newStatus === status) return
    if (recordsPayment(newStatus)) {
      setPaidDate(todayStr)
      setPaidMethod('bank')
      setPaidDateInvalid(false)
    }
    if (needsNumber(newStatus)) { void prepareIssue(newStatus); return }
    if (DESTRUCTIVE.has(newStatus) || recordsPayment(newStatus)) {
      if (createsStorno(newStatus)) setStornoReason('')
      setConfirm(newStatus)
      return
    }
    void applyStatus(newStatus)
  }

  // Issuing a draft asks the same as the editor does: today's date for a stale draft, a date
  // before the newest issued document, a zero total. The editor's pending edits are written
  // first, so the dialog and the checks see the draft as it is.
  async function prepareIssue(newStatus: string) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await flushPendingEdits(doc.id)
      const numberingColumns = `${type}_number_format, ${type}_prefix, next_${type}_number, ${type}_counter_year, ${type}_number_reset_yearly`
      const [draft, settings, latest] = await Promise.all([
        supabase.from('documents')
          .select('date, currency, tax_treatment, discount_type, discount_value, clients(payment_days), document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)')
          .eq('id', doc.id).single(),
        supabase.from('settings').select(`${numberingColumns}, default_payment_days, default_quote_validity_days`).maybeSingle(),
        supabase.from('documents').select('number, date').eq('type', type).not('number', 'is', null).neq('id', doc.id)
          .order('date', { ascending: false }).limit(1).maybeSingle(),
      ])
      if (draft.error || !draft.data) { toast.error(draft.error ? lifecycleErrorMessage(draft.error, t) : t('messages.api.not_found')); return }
      const d = draft.data
      const s = (settings.data ?? {}) as Partial<NumberingSettings & Pick<Settings, 'default_payment_days' | 'default_quote_validity_days'>>
      // Many-to-one: PostgREST returns the client as an object, the untyped client infers an array.
      const client = d.clients as unknown as { payment_days: number | null } | null
      const total = calcTotals(
        d.document_items ?? [],
        [],
        d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
        d.tax_treatment,
      ).total
      setIssue({
        status: newStatus,
        draftDate: d.date,
        staleDate: d.date < todayStr ? d.date : null,
        todayDue: addDays(todayStr, termDays(type, { default_payment_days: s.default_payment_days ?? 14, default_quote_validity_days: s.default_quote_validity_days ?? 14 }, client)),
        latestIssued: latest.data?.number ? { number: latest.data.number, date: latest.data.date } : null,
        numbering: s,
        zeroTotal: total === 0 ? formatMoney(0, d.currency ?? 'EUR') : null,
        problems: null,
      })
    } catch (err) {
      toast.error(requestErrorMessage(t, err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function confirmIssue(useToday: boolean) {
    const prep = issue
    if (!prep || busyRef.current) return
    const newStatus = prep.status
    if (recordsPayment(newStatus) && (!/^\d{4}-\d{2}-\d{2}$/.test(paidDate) || paidDate > todayStr)) {
      setPaidDateInvalid(true)
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      // A stale draft moves to today; the editor on this page writes the new dates itself, so it
      // never writes the old ones back.
      if (prep.staleDate && useToday) {
        // Credit notes have no payment term to follow the new date.
        const todayDue = type === 'credit_note' ? undefined : prep.todayDue
        const handled = await applyIssueDateInEditor(doc.id, todayStr, todayDue).catch((err: unknown) => {
          toast.error(t('builder.notSavedToast', { error: lifecycleErrorMessage(asDbError(err), t) }))
          return null
        })
        if (handled === null) return
        if (!handled) {
          const { error } = await supabase.from('documents')
            .update({ date: todayStr, ...(todayDue === undefined ? {} : { due_date: todayDue }) }).eq('id', doc.id)
          if (error) { toast.error(lifecycleErrorMessage(error, t)); return }
        }
      }
      const showProblems = (problems: IssueProblem[]) => setIssue(p => (p ? { ...p, problems } : p))
      if (recordsPayment(newStatus)) {
        const res = await fetch('/api/invoices/bulk', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [doc.id], status: 'paid', paidDate, method: paidMethod }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.status === 422 && isIssueProblems(data.problems)) { showProblems(data.problems); return }
        if (!res.ok) { toast.error(apiErrorMessage(t, data, t('statusBar.markPaidFailed'))); return }
        if (!data.updated) { toast.error(t('statusBar.cannotMarkPaid')); return }
      } else {
        // Issuing (number, archive copy, Drive) runs on the server and moves a draft to 'sent'.
        const res = await fetch(`/api/documents/${doc.id}/issue`, { method: 'POST' })
        const data = await res.json().catch(() => ({}))
        if (res.status === 422 && isIssueProblems(data.problems)) { showProblems(data.problems); return }
        if (!res.ok) { toast.error(apiErrorMessage(t, data, t('messages.api.issue_failed'))); return }
        if (data.snapshotError) toast.error(t('messages.archiveLater'))
        if (data.driveError) toastApiError(t, data.driveError, t('builder.driveFailedPrefix'))
        const from = status === 'draft' ? 'sent' : status
        if (newStatus !== from) {
          const { error } = await supabase.from('documents').update({ status: newStatus }).eq('id', doc.id)
          if (error) { toast.error(lifecycleErrorMessage(error, t)); return }
          await logEvent(supabase, doc.id, 'status_changed', { from, to: newStatus })
        }
      }
      setStatus(newStatus)
      setIssue(null)
      router.refresh()
      toast.success(recordsPayment(newStatus) ? t('statusBar.markedPaid') : t('statusBar.statusUpdated', { status: statusLabel(newStatus) }))
    } catch (err) {
      toast.error(requestErrorMessage(t, err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function applyStatus(newStatus: string) {
    if (busyRef.current) return
    if (recordsPayment(newStatus) && (!/^\d{4}-\d{2}-\d{2}$/.test(paidDate) || paidDate > todayStr)) {
      setPaidDateInvalid(true)
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      // A Storno copies the invoice's lines from the database, so the builder's pending edits go first.
      if (createsStorno(newStatus)) await flushPendingEdits(doc.id)
      if (createsStorno(newStatus)) {
        const res = await fetch(`/api/invoices/${doc.id}/convert-to-credit-note`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cancel: true, reason: stornoReason.trim() || undefined }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { toast.error(apiErrorMessage(t, data, t('statusBar.stornoFailed'))); return }
        if (data.snapshotError) toast.error(t('messages.archiveLater'))
        if (data.driveError) toastApiError(t, data.driveError, t('builder.driveFailedPrefix'))
        setConfirm(null)
        toast.success(t('statusBar.invoiceCancelled', { number: data.number ?? '' }))
        router.push(`/credit-notes/${data.creditNoteId}`)
        return
      }
      if (recordsPayment(newStatus)) {
        const res = await fetch('/api/invoices/bulk', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [doc.id], status: 'paid', paidDate, method: paidMethod }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { toast.error(apiErrorMessage(t, data, t('statusBar.markPaidFailed'))); return }
        if (!data.updated) { toast.error(t('statusBar.cannotMarkPaid')); return }
      } else {
        const from = status
        if (newStatus !== from) {
          const { error } = await supabase.from('documents').update({ status: newStatus }).eq('id', doc.id)
          if (error) { toast.error(lifecycleErrorMessage(error, t)); return }
          await logEvent(supabase, doc.id, 'status_changed', { from, to: newStatus })
        }
      }
      setStatus(newStatus)
      setConfirm(null)
      router.refresh()
      toast.success(recordsPayment(newStatus) ? t('statusBar.markedPaid') : t('statusBar.statusUpdated', { status: statusLabel(newStatus) }))
    } catch (err) {
      toast.error(requestErrorMessage(t, err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const confirmText = (s: string) => {
    if (createsStorno(s)) return t('statusBar.confirmStorno', { number: doc.number ?? '' })
    const parts: string[] = []
    if (needsNumber(s)) parts.push(t('statusBar.confirmNumber', { number: t(`docTypeNumber.${type}` as DictKey), status: statusLabel(s) }))
    if (recordsPayment(s)) parts.push(t('statusBar.confirmPayment'))
    if (DESTRUCTIVE.has(s)) parts.push(t('statusBar.confirmDestructive'))
    return parts.join(' ')
  }

  const paymentFields = (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <label htmlFor={`${uid}-paid-date`} className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{t('payments.paymentDate')}</label>
        <input
          id={`${uid}-paid-date`}
          type="date"
          value={paidDate}
          max={todayStr}
          required
          aria-invalid={paidDateInvalid || undefined}
          aria-describedby={paidDateInvalid ? `${uid}-paid-date-error` : undefined}
          onChange={e => { setPaidDate(e.target.value); setPaidDateInvalid(false) }}
          className={`w-full ${inputClass} ${paidDateInvalid ? 'border-red-500 dark:border-red-500' : ''}`}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${uid}-paid-method`} className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{t('payments.paymentMethod')}</label>
        <select id={`${uid}-paid-method`} value={paidMethod} onChange={e => setPaidMethod(e.target.value as PaymentMethod)} className={`w-full ${inputClass}`}>
          <option value="bank">{t('payments.methodBank')}</option>
          <option value="cash">{t('payments.methodCash')}</option>
        </select>
      </div>
      {paidDateInvalid && <p id={`${uid}-paid-date-error`} role="alert" className="col-span-2 text-xs text-red-600 dark:text-red-400">{t('lifecycle.paymentDateInvalid')}</p>}
    </div>
  )

  // Cancelled documents and issued credit notes have nowhere to go: the badge is just a label.
  if (!targets.length) return <StatusBadge status={shown} label={statusLabel(shown)} className="shrink-0" />

  return (
    <div className="relative" ref={ref} onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('statusBar.statusAria', { status: statusLabel(shown) })}
        className="flex items-center gap-0.5 rounded-full py-1 -my-1 text-neutral-500 dark:text-neutral-400"
      >
        <StatusBadge status={shown} label={statusLabel(shown)} />
        <ChevronDown size={12} aria-hidden="true" className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div role="menu" aria-label={t('statusBar.changeStatus')} className="absolute top-full left-0 mt-1.5 z-10 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg py-1 min-w-36 overflow-hidden">
          {[status, ...targets].map(s => (
            <button
              key={s}
              type="button"
              role="menuitem"
              aria-current={s === status ? 'true' : undefined}
              onClick={() => changeStatus(s)}
              className={`w-full text-left px-3 py-2 sm:py-1.5 text-sm transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800 flex items-center justify-between gap-2
                ${s === status ? 'font-medium' : ''}
                ${STATUS_TEXT[s] ?? 'text-neutral-700 dark:text-neutral-300'}`}
            >
              {statusLabel(s)}
              {s === status && <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />}
            </button>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm ? (createsStorno(confirm) ? t('lifecycle.stornoTitle', { number: doc.number ?? '' }) : t('statusBar.markAsTitle', { status: statusLabel(confirm) })) : ''}
        description={confirm ? confirmText(confirm) : undefined}
        confirmLabel={busy ? t('common.working') : t('common.confirm')}
        destructive={!!confirm && DESTRUCTIVE.has(confirm)}
        busy={busy}
        onConfirm={() => { if (confirm) void applyStatus(confirm) }}
        onCancel={() => setConfirm(null)}
      >
        {confirm && recordsPayment(confirm) && paymentFields}
        {confirm && createsStorno(confirm) && (
          <div className="space-y-1">
            <label htmlFor={`${uid}-storno-reason`} className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{t('lifecycle.storno.reason')}</label>
            <input
              id={`${uid}-storno-reason`}
              type="text"
              value={stornoReason}
              maxLength={500}
              placeholder={t('lifecycle.storno.reasonPlaceholder')}
              onChange={e => setStornoReason(e.target.value)}
              className={`w-full ${inputClass}`}
            />
          </div>
        )}
      </ConfirmDialog>

      <IssueDialog
        open={!!issue}
        type={type}
        title={issue ? t('statusBar.markAsTitle', { status: statusLabel(issue.status) }) : ''}
        description={issue ? confirmText(issue.status) : undefined}
        confirmLabel={busy ? t('common.working') : t('common.confirm')}
        busy={busy}
        staleDate={issue?.staleDate ?? null}
        draftDate={issue?.draftDate ?? todayStr}
        todayDue={type === 'invoice' && issue ? issue.todayDue : null}
        latestIssued={issue?.latestIssued ?? null}
        numberFor={d => (issue ? expectedNumber(issue.numbering, type, d) : '')}
        zeroTotal={issue?.zeroTotal ?? null}
        problems={issue?.problems}
        onConfirm={useToday => void confirmIssue(useToday)}
        onCancel={() => setIssue(null)}
      >
        {issue && recordsPayment(issue.status) && paymentFields}
        {issue && type === 'invoice' && <ProjectLinkWarning documentId={doc.id} />}
      </IssueDialog>
    </div>
  )
}
