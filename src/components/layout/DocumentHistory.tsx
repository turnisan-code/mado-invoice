import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import type { DictKey, TFn, UiLang } from '@/lib/i18n'
import { entriesLabel } from '@/lib/projects'
import { formatMoney } from '@/lib/utils/document'
import { reminderTitle } from '@/lib/utils/reminder-templates'
import type { DocumentEvent } from '@/types'

const DOC_PATHS: Record<string, string> = { invoice: 'invoices', quote: 'quotes', credit_note: 'credit-notes' }

type Row = {
  text: string
  subs?: (string | null)[]
  link?: { href: string; label: string; external?: boolean }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

// Detail fields written by older code or other writers may be strings or numbers.
function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

function idText(value: unknown): string | null {
  return str(value) ?? (num(value) != null ? String(value) : null)
}

function addresses(value: unknown): string | null {
  const list = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && !!v.trim())
  return list.length ? list.join(', ') : null
}

function describe(event: DocumentEvent, t: TFn, lang: UiLang, currency: string): Row {
  const d = event.detail ?? {}
  const statusLabel = (value: unknown) => (str(value) ? t(`status.${str(value)}` as DictKey) : '')
  const subject = str(d.subject) ? t('archive.subject', { subject: str(d.subject)! }) : null
  const reason = str(d.reason) ? t('lifecycle.storno.reasonShort', { reason: str(d.reason)! }) : null
  const cc = addresses(d.cc)
  const bcc = addresses(d.bcc)
  const copies = [cc && t('docs.history.cc', { list: cc }), bcc && t('docs.history.bcc', { list: bcc })].filter(Boolean).join(' · ') || null
  const level = typeof d.level === 'number' ? d.level : null

  switch (event.type) {
    case 'issued': {
      const number = str(d.number)
      return { text: number ? t('archive.events.issued', { number }) : t('archive.events.issuedPlain') }
    }
    case 'emailed': {
      const to = str(d.to)
      return { text: to ? t('archive.events.emailed', { to }) : t('archive.events.emailedPlain'), subs: [copies, subject] }
    }
    case 'mailto_opened': {
      const to = str(d.to)
      // Opened from the reminder dialog: the level says which reminder the email carries.
      if (level != null) {
        const title = reminderTitle(level, lang)
        return { text: to ? t('docs.history.reminderMailto', { title, to }) : t('docs.history.reminderMailtoPlain', { title }), subs: [subject] }
      }
      return { text: to ? t('archive.events.mailto_opened', { to }) : t('docs.history.mailtoPlain'), subs: [subject] }
    }
    case 'reminder_sent': {
      const title = reminderTitle(level ?? 1, lang)
      const to = str(d.to)
      const text = d.manual
        ? to ? t('docs.history.reminderManualTo', { title, to }) : t('docs.history.reminderManual', { title })
        : to ? t('archive.events.reminder_sent', { title, to }) : t('archive.events.reminder_sentPlain', { title })
      return { text: d.automatic ? `${text} · ${t('archive.automatic')}` : text, subs: [copies, subject] }
    }
    case 'status_changed': {
      const text = t('archive.events.status_changed', { from: statusLabel(d.from), to: statusLabel(d.to) })
      return { text: d.automatic ? `${text} · ${t('archive.automatic')}` : text }
    }
    case 'payment_added':
    case 'payment_removed': {
      const raw = str(d.kind)
      const kind = raw === 'skonto' || raw === 'writeoff' ? raw : 'payment'
      const amount = typeof d.amount === 'number' ? formatMoney(d.amount, currency) : ''
      const kindLabel = raw === 'credit' ? t('lifecycle.payments.creditNotePlain') : raw === 'refund' ? t('lifecycle.credit.refund') : raw === 'fee' ? t('books.fees.kind') : t(`archive.paymentKinds.${kind}` as DictKey)
      const creditNote = raw === 'credit' ? str(d.credit_note_id) : null
      return {
        text: t(`archive.events.${event.type}`, { kind: kindLabel, amount }),
        subs: [d.method === 'cash' && (raw === 'payment' || raw === 'refund' || raw === 'fee' || !raw) ? t('payments.cashBadge') : str(d.credit_note_number)],
        link: creditNote ? { href: `/credit-notes/${creditNote}`, label: t('archive.openSource') } : undefined,
      }
    }
    case 'storno_created': {
      const id = str(d.credit_note_id)
      return {
        text: t('archive.events.storno_created'),
        subs: [reason],
        link: id ? { href: `/credit-notes/${id}`, label: t('archive.openStorno') } : undefined,
      }
    }
    case 'converted': {
      const toId = str(d.to_id)
      const toPath = DOC_PATHS[str(d.to_type) ?? '']
      if (toId && toPath) return { text: t('lifecycle.history.convertedToInvoice'), link: { href: `/${toPath}/${toId}`, label: t('archive.openSource') } }
      const number = str(d.from_number)
      const path = DOC_PATHS[str(d.from_type) ?? '']
      const id = str(d.from_id)
      return {
        text: number ? t('archive.events.converted', { number }) : t('archive.events.convertedPlain'),
        subs: [reason],
        link: path && id ? { href: `/${path}/${id}`, label: t('archive.openSource') } : undefined,
      }
    }
    case 'archived':
      return { text: t(d.restored ? 'archive.events.archivedRestored' : 'archive.events.archived') }
    case 'drive_archived': {
      const href = str(d.link)
      return {
        text: t('archive.events.drive_archived'),
        subs: [str(d.name)],
        link: href ? { href, label: t('archive.openInDrive'), external: true } : undefined,
      }
    }
    case 'bookamat_synced': {
      const booking = idText(d.booking_id)
      const year = num(d.year)
      const amount = num(d.amount)
      const parts = [
        booking && t('docs.history.booking', { id: booking }),
        year != null && t('docs.history.bookingYear', { year }),
        amount != null && formatMoney(amount, currency),
      ].filter(Boolean)
      return { text: t('archive.events.bookamat_synced'), subs: [parts.join(' · ') || null] }
    }
    case 'portal_responded':
      return { text: d.action === 'accepted' ? t('lifecycle.history.portalAccepted') : d.action === 'rejected' ? t('lifecycle.history.portalRejected') : t('archive.events.portal_responded') }
    case 'einvoice_exported':
      return { text: t('einvoice.history.exported', { format: t(d.format === 'ubl' ? 'einvoice.formats.ubl' : 'einvoice.formats.ebinterface') }) }
    case 'deposit_created': {
      const id = str(d.to_id)
      const amount = num(d.amount)
      return {
        text: amount != null ? t('deposits.history.created', { amount: formatMoney(amount, currency) }) : t('deposits.history.createdPlain'),
        link: id ? { href: `/invoices/${id}`, label: t('deposits.history.openInvoice') } : undefined,
      }
    }
    case 'deposit_linked':
    case 'deposit_released': {
      const finalId = str(d.final_id)
      const invoiceId = str(d.invoice_id)
      const released = { storno: 'releasedStorno', cancelled: 'releasedCancelled', deleted: 'releasedDeleted', self_cancelled: 'releasedSelf' } as const
      const number = str(d.invoice_number) ?? ''
      const text = event.type === 'deposit_linked'
        ? invoiceId ? t('deposits.history.linkedInvoice', { number }) : t('deposits.history.linked')
        : invoiceId ? t('deposits.history.releasedInvoice', { number })
        : t(`deposits.history.${released[str(d.reason) as keyof typeof released] ?? 'releasedRemoved'}`, { number: str(d.final_number) ?? '' })
      const link = invoiceId ? { href: `/invoices/${invoiceId}`, label: t('deposits.history.openInvoice') }
        : finalId ? { href: `/invoices/${finalId}`, label: t('deposits.history.openFinal') } : undefined
      return { text, link }
    }
    case 'project_invoiced': {
      const project = str(d.project_name)
      const id = str(d.project_id)
      const entries = entriesLabel(t, num(d.time_entries) ?? 0, num(d.expenses) ?? 0)
      return {
        text: project ? t('records.history.projectInvoiced', { project, entries }) : t('records.history.projectInvoicedPlain', { entries }),
        link: id ? { href: `/projects/${id}`, label: t('records.history.openProject') } : undefined,
      }
    }
    case 'project_released': {
      const why = str(d.reason)
      const reason = why === 'line_removed' || why === 'storno' || why === 'cancelled' ? why : 'manual'
      const storno = reason === 'storno' ? str(d.credit_note_id) : null
      return {
        text: t(`records.history.released.${reason}`, { entries: entriesLabel(t, num(d.time_entries) ?? 0, num(d.expenses) ?? 0) }),
        subs: [storno ? str(d.credit_note_number) : null],
        link: storno ? { href: `/credit-notes/${storno}`, label: t('archive.openStorno') } : undefined,
      }
    }
    default:
      return { text: t(`archive.events.${event.type}`) }
  }
}

// Newest first. Renders nothing until something has happened to the document.
export default async function DocumentHistory({ documentId, currency }: { documentId: string; currency: string }) {
  const supabase = await createClient()
  const [{ t, lang }, { data, error }] = await Promise.all([
    getT(),
    supabase
      .from('document_events')
      .select('id, document_id, created_at, type, detail')
      .eq('document_id', documentId)
      .order('created_at', { ascending: false })
      .limit(200),
  ])
  if (error) console.error('[DocumentHistory]', error.message)
  const events = (data ?? []) as DocumentEvent[]
  if (!events.length) return null

  const when = new Intl.DateTimeFormat(lang === 'de' ? 'de-AT' : 'en-GB', {
    timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const linkCls = 'underline underline-offset-2 text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100'

  return (
    <section aria-labelledby="document-history" className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6 space-y-3">
      <h2 id="document-history" className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">{t('archive.history')}</h2>
      <ol className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
        {events.map(event => {
          const row = describe(event, t, lang, currency)
          return (
            <li key={event.id} className="py-2 flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3">
              <time dateTime={event.created_at} className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 sm:w-36 shrink-0 tabular-nums">
                {when.format(new Date(event.created_at))}
              </time>
              <div className="min-w-0 flex-1">
                <p className="text-neutral-800 dark:text-neutral-200 break-words">
                  {row.text}
                  {row.link && (
                    <>
                      {' · '}
                      {row.link.external
                        ? <a href={row.link.href} target="_blank" rel="noopener" className={linkCls}>{row.link.label}</a>
                        : <Link href={row.link.href} className={linkCls}>{row.link.label}</Link>}
                    </>
                  )}
                </p>
                {row.subs?.filter(Boolean).map((sub, i) => (
                  <p key={i} className="text-xs text-neutral-500 dark:text-neutral-400 break-words">{sub}</p>
                ))}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
