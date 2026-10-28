import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import type { DictKey, TFn, UiLang } from '@/lib/i18n'
import { formatMoney } from '@/lib/utils/document'
import { reminderTitle } from '@/lib/utils/reminder-templates'
import type { DocumentEvent } from '@/types'

const DOC_PATHS: Record<string, string> = { invoice: 'invoices', quote: 'quotes', credit_note: 'credit-notes' }

type Row = {
  text: string
  sub?: string | null
  link?: { href: string; label: string; external?: boolean }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function describe(event: DocumentEvent, t: TFn, lang: UiLang, currency: string): Row {
  const d = event.detail ?? {}
  const statusLabel = (value: unknown) => (str(value) ? t(`status.${str(value)}` as DictKey) : '')
  const subject = str(d.subject) ? t('archive.subject', { subject: str(d.subject)! }) : null

  switch (event.type) {
    case 'issued': {
      const number = str(d.number)
      return { text: number ? t('archive.events.issued', { number }) : t('archive.events.issuedPlain') }
    }
    case 'emailed': {
      const to = str(d.to)
      return { text: to ? t('archive.events.emailed', { to }) : t('archive.events.emailedPlain'), sub: subject }
    }
    case 'mailto_opened':
      return { text: t('archive.events.mailto_opened', { to: str(d.to) ?? '' }), sub: subject }
    case 'reminder_sent': {
      const title = reminderTitle(typeof d.level === 'number' ? d.level : 1, lang)
      const to = str(d.to)
      const text = to ? t('archive.events.reminder_sent', { title, to }) : t('archive.events.reminder_sentPlain', { title })
      return { text: d.automatic ? `${text} · ${t('archive.automatic')}` : text, sub: subject }
    }
    case 'status_changed':
      return { text: t('archive.events.status_changed', { from: statusLabel(d.from), to: statusLabel(d.to) }) }
    case 'payment_added':
    case 'payment_removed': {
      const kind = str(d.kind) === 'skonto' || str(d.kind) === 'writeoff' ? str(d.kind)! : 'payment'
      const amount = typeof d.amount === 'number' ? formatMoney(d.amount, currency) : ''
      return {
        text: t(`archive.events.${event.type}`, { kind: t(`archive.paymentKinds.${kind}` as DictKey), amount }),
        sub: d.method === 'cash' && kind === 'payment' ? t('payments.cashBadge') : null,
      }
    }
    case 'storno_created': {
      const id = str(d.credit_note_id)
      return {
        text: t('archive.events.storno_created'),
        link: id ? { href: `/credit-notes/${id}`, label: t('archive.openStorno') } : undefined,
      }
    }
    case 'converted': {
      const number = str(d.from_number)
      const path = DOC_PATHS[str(d.from_type) ?? '']
      const id = str(d.from_id)
      return {
        text: number ? t('archive.events.converted', { number }) : t('archive.events.convertedPlain'),
        link: path && id ? { href: `/${path}/${id}`, label: t('archive.openSource') } : undefined,
      }
    }
    case 'archived':
      return { text: t(d.restored ? 'archive.events.archivedRestored' : 'archive.events.archived') }
    case 'drive_archived': {
      const href = str(d.link)
      return {
        text: t('archive.events.drive_archived'),
        sub: str(d.name),
        link: href ? { href, label: t('archive.openInDrive'), external: true } : undefined,
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
                {row.sub && <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">{row.sub}</p>}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
