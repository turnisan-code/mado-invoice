// The stored preview and outcome of an action, as the owner reads them before and after approving.
// Everything comes from the mcp_actions row the server wrote; text in it (client names, addresses,
// subjects, bodies) is shown as text, never as markup.
import { Fragment } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { TFn, UiLang } from '@/lib/i18n'
import { StatusBadge } from '@/components/lists/StatusBadge'
import { isWorded, word, type Worded } from '@/lib/mcp/actions/words'
import type { ActionState } from '@/lib/mcp/confirm'
import { formatDate, formatMoney } from '@/lib/utils/document'
import { bookamatErrorMessage } from '@/lib/bookamat-client'
import { knownApiError } from '@/lib/api-errors'
import { lifecycleErrorMessage } from '@/lib/status'
import type { McpAction } from '@/types'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const strings = (v: unknown): string[] => list(v).map(text).filter(Boolean)
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)

const BADGE: Record<ActionState, string> = {
  pending: 'sent', running: 'paused', unknown: 'partially_paid', done: 'paid', failed: 'overdue', rejected: 'cancelled', expired: 'draft',
}

export function StateBadge({ state, t }: { state: ActionState; t: TFn }) {
  return <StatusBadge status={BADGE[state]} label={t(`mcp.approve.status.${state}`)} />
}

export function wordedList(t: TFn, lang: UiLang, value: unknown): string[] {
  return list(value).filter(isWorded).map(w => word(t, lang, w as Worded))
}

const cardCls = 'rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900'
const labelCls = 'text-xs text-neutral-500 dark:text-neutral-400'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 py-1.5 text-sm">
      <dt className={labelCls + ' pt-0.5'}>{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function DocLine({ d, t, lang, expected }: { d: Obj; t: TFn; lang: UiLang; expected?: boolean }) {
  const currency = text(d.currency) || 'EUR'
  const number = text(expected ? d.expected_number : d.number)
  return (
    <li className="py-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
      <div className="min-w-0">
        <a href={text(d.app_url)} className="font-medium underline-offset-2 hover:underline">{number || t('mcp.approve.preview.draft')}</a>
        {d.type ? <span className="text-neutral-500 dark:text-neutral-400"> · {t(`mcp.approve.types.${text(d.type) as 'invoice'}`)}</span> : null}
        <div className="text-neutral-600 dark:text-neutral-300 truncate">{text(obj(d.client).name ?? d.client)}</div>
      </div>
      <div className="text-right tabular-nums">
        {d.gross !== undefined && <div className="font-medium">{formatMoney(num(d.gross), currency, lang)}</div>}
        {d.issue_date ? (
          <div className={labelCls}>
            {formatDate(text(d.issue_date), lang)}{d.due_date ? ` → ${formatDate(text(d.due_date), lang)}` : ''}
          </div>
        ) : null}
      </div>
    </li>
  )
}

function Addresses({ values, foreign, t }: { values: string[]; foreign: string[]; t: TFn }) {
  const strange = new Set(foreign.map(a => a.toLowerCase()))
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1">
      {values.map(a => (
        <span key={a} className={strange.has(a.toLowerCase()) ? 'font-medium text-amber-700 dark:text-amber-400' : ''}>
          {a}{strange.has(a.toLowerCase()) && <span className="ml-1 text-xs font-normal">({t('mcp.approve.preview.notOnRecord')})</span>}
        </span>
      ))}
    </span>
  )
}

function EmailBlock({ email, t }: { email: Obj; t: TFn }) {
  const foreign = strings(email.foreign)
  const body = text(email.body)
  return (
    <section className={cardCls + ' p-4 sm:p-5'}>
      <h3 className="text-sm font-semibold mb-1">{t('mcp.approve.preview.email')}</h3>
      <dl className="divide-y divide-neutral-100 dark:divide-neutral-800">
        {email.from ? <Field label={t('mcp.approve.preview.from')}>{text(email.from)}</Field> : null}
        <Field label={t('mcp.approve.preview.to')}><Addresses values={strings(email.to)} foreign={foreign} t={t} /></Field>
        {strings(email.cc).length > 0 && <Field label={t('mcp.approve.preview.cc')}><Addresses values={strings(email.cc)} foreign={foreign} t={t} /></Field>}
        {strings(email.bcc).length > 0 && <Field label={t('mcp.approve.preview.bcc')}><Addresses values={strings(email.bcc)} foreign={foreign} t={t} /></Field>}
        {email.subject !== undefined && <Field label={t('mcp.approve.preview.subject')}>{text(email.subject)}</Field>}
        {strings(email.attachments).length > 0 && <Field label={t('mcp.approve.preview.attachments')}>{strings(email.attachments).join(', ')}</Field>}
      </dl>
      {body && (
        <div className="mt-3">
          <div className={labelCls + ' mb-1'}>{t('mcp.approve.preview.text')}</div>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm rounded-lg bg-neutral-50 dark:bg-neutral-950 border border-neutral-100 dark:border-neutral-800 p-3 max-h-96 overflow-y-auto">{body}</pre>
        </div>
      )}
    </section>
  )
}

function Documents({ docs, t, lang, expected }: { docs: unknown[]; t: TFn; lang: UiLang; expected?: boolean }) {
  return (
    <section className={cardCls + ' px-4 sm:px-5 py-2'}>
      <h3 className="text-sm font-semibold pt-2">{t(docs.length > 1 ? 'mcp.approve.preview.documents' : 'mcp.approve.preview.document')}</h3>
      <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
        {docs.map((d, i) => <DocLine key={text(obj(d).id) || i} d={obj(d)} t={t} lang={lang} expected={expected} />)}
      </ul>
    </section>
  )
}

function Figures({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {rows.map(([label, value]) => <Field key={label} label={label}><span className="tabular-nums">{value}</span></Field>)}
    </dl>
  )
}

// What approving would do, per kind.
export function ActionPreview({ row, t, lang }: { row: Pick<McpAction, 'kind' | 'preview'>; t: TFn; lang: UiLang }) {
  const p = obj(row.preview)
  const money = (v: unknown, currency?: unknown) => formatMoney(num(v), text(currency) || 'EUR', lang)
  switch (row.kind) {
    case 'issue':
      return <Documents docs={list(p.documents)} t={t} lang={lang} expected />
    case 'issue_and_send':
      return <><Documents docs={list(p.documents)} t={t} lang={lang} expected /><EmailBlock email={obj(p.email)} t={t} /></>
    case 'send_email':
      return <><Documents docs={[p.document]} t={t} lang={lang} /><EmailBlock email={obj(p.email)} t={t} /></>
    case 'send_reminder': {
      const inv = obj(p.invoice)
      const f = obj(p.figures)
      const rows: [string, string][] = [
        [t('mcp.approve.preview.reminder'), `${text(p.title)} · ${t('mcp.approve.preview.level', { level: num(p.level) })}`],
        [t('mcp.approve.preview.balance'), money(f.balance, inv.currency)],
      ]
      if (num(f.fee) > 0) rows.push([t('mcp.approve.preview.fee'), money(f.fee, inv.currency)])
      if (num(f.interest) > 0) rows.push([t('mcp.approve.preview.interest'), money(f.interest, inv.currency)])
      rows.push([t('mcp.approve.preview.totalDue'), money(f.total_due, inv.currency)])
      if (f.new_deadline) rows.push([t('mcp.approve.preview.newDeadline'), formatDate(text(f.new_deadline), lang)])
      return (
        <>
          <Documents docs={[{ ...inv, type: 'invoice' }]} t={t} lang={lang} />
          <section className={cardCls + ' px-4 sm:px-5 py-2'}><Figures rows={rows} /></section>
          {p.mode === 'gmail'
            ? <EmailBlock email={obj(p.email)} t={t} />
            : <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('mcp.approve.preview.recordedOnly')}</p>}
        </>
      )
    }
    case 'storno': {
      const inv = obj(p.invoice)
      const cn = obj(p.credit_note)
      const rows: [string, string][] = [
        [t('mcp.approve.preview.creditNote'), `${text(cn.expected_number)} · ${formatDate(text(cn.date), lang)}`],
        [t('mcp.approve.preview.amount'), money(cn.amount, inv.currency)],
        [t('mcp.approve.preview.applied'), money(cn.applied, inv.currency)],
      ]
      if (num(cn.refund) > 0) rows.push([t('mcp.approve.preview.refund'), money(cn.refund, inv.currency)])
      if (p.reason) rows.push([t('mcp.approve.preview.reason'), text(p.reason)])
      return (
        <>
          <Documents docs={[{ ...inv, type: 'invoice', gross: inv.total }]} t={t} lang={lang} />
          <section className={cardCls + ' px-4 sm:px-5 py-2'}><Figures rows={rows} /></section>
        </>
      )
    }
    case 'cancel':
      return <Documents docs={[p.document]} t={t} lang={lang} />
    case 'delete': {
      const target = obj(p.target)
      if (target.kind === 'draft') return <Documents docs={[target]} t={t} lang={lang} />
      return (
        <section className={cardCls + ' px-4 sm:px-5 py-2'}>
          <Figures rows={[
            ...(target.project ? [[t('mcp.approve.preview.project'), text(target.project)] as [string, string]] : []),
            [t('mcp.approve.preview.client'), text(target.client)],
          ]} />
        </section>
      )
    }
    case 'bookamat_sync': {
      const doc = obj(p.document)
      const bookings = list(p.bookings).map(obj)
      return (
        <>
          <Documents docs={[{ ...doc, gross: doc.total }]} t={t} lang={lang} />
          <section className={cardCls + ' px-4 sm:px-5 py-2'}>
            <h3 className="text-sm font-semibold pt-2">{t('mcp.approve.preview.bookings')}</h3>
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
              {bookings.map(b => (
                <li key={`${num(b.year)}-${text(b.kind)}`} className="py-2 flex justify-between gap-3">
                  <span>{num(b.year)} · {t('mcp.approve.preview.bookingDate')} {formatDate(text(b.date), lang)}</span>
                  <span className="tabular-nums text-right">
                    {money(b.kind === 'refund' ? -num(b.amount) : b.amount)}
                    {num(b.cash) > 0 && <span className={'block ' + labelCls}>{t('mcp.approve.preview.cash', { amount: money(b.cash) })}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {num(p.fees) > 0 && <Figures rows={[[t('mcp.approve.preview.fees'), money(p.fees)]]} />}
          </section>
        </>
      )
    }
  }
}

export function Notices({ items, t }: { items: string[]; t: TFn }) {
  if (!items.length) return null
  return (
    <section role="note" className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
      <h3 className="font-medium flex items-center gap-1.5 mb-1"><AlertTriangle size={14} aria-hidden="true" /> {t('mcp.approve.noticesHeading')}</h3>
      <ul className="list-disc pl-5 space-y-1">
        {items.map((item, i) => <li key={i}>{item}</li>)}
      </ul>
    </section>
  )
}

// A stored failure in the owner's language where its code is one the app words; otherwise the
// English text it was stored with.
export function storedErrorText(error: unknown, t: TFn): string {
  const e = obj(error)
  const code = text(e.code)
  const message = text(e.message)
  const details = obj(e.details)
  if (code.startsWith('einvoice_')) return t(`einvoice.errors.${code.slice('einvoice_'.length)}` as 'einvoice.errors.not_issued')
  if (code.startsWith('bookamat_')) return bookamatErrorMessage(t, { code: code.slice('bookamat_'.length), error: message, detail: details.detail ?? details })
  if (/^MI0\d\d$/.test(code)) return lifecycleErrorMessage({ code, message, details: text(details.detail) || null }, t)
  if (code === 'state_changed') return t('mcp.errors.stateChanged')
  if (code === 'deadline') return t('mcp.errors.deadline')
  return knownApiError(t, { code, error: message, problems: details.problems }) ?? (message || t('mcp.approve.errors.generic'))
}

// What came of it: the result lines in the owner's language, with links to what was made.
export function ActionResult({ row, state, t, lang }: { row: Pick<McpAction, 'result' | 'error'>; state: ActionState; t: TFn; lang: UiLang }) {
  if (state === 'failed') {
    return (
      <section role="alert" className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-800 dark:text-red-300">
        <h3 className="font-medium mb-1">{t('mcp.approve.failedHeading')}</h3>
        <p>{storedErrorText(row.error, t)}</p>
      </section>
    )
  }
  if (state !== 'done') return null
  const data = obj(obj(row.result).data)
  const lines = wordedList(t, lang, data.report)
  const links = [
    ...list(data.issued).map(obj).map(d => ({ href: text(d.app_url), pdf: text(d.pdf_url), label: text(d.number) })),
    ...(data.credit_note_id ? [{ href: text(data.app_url), pdf: text(data.pdf_url), label: text(data.number) }] : []),
  ].filter(l => l.href)
  return (
    <section className="rounded-xl border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 px-4 py-3 text-sm text-green-900 dark:text-green-200 space-y-2">
      <h3 className="font-medium">{t('mcp.approve.doneHeading')}</h3>
      <ul className="space-y-1">{lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
      {links.length > 0 && (
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          {links.map(l => (
            <Fragment key={l.href}>
              <a href={l.href} className="underline underline-offset-2">{t('mcp.approve.open')} {l.label}</a>
              {l.pdf && <a href={l.pdf} target="_blank" rel="noopener" className="underline underline-offset-2">{t('mcp.approve.openPdf')}</a>}
            </Fragment>
          ))}
        </p>
      )}
    </section>
  )
}
