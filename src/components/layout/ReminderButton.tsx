'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Bell, BellRing, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { toastApiError } from '@/lib/google/toast'
import { nextReminderLevel, reminderTitle } from '@/lib/utils/reminder-templates'
import { formatDate } from '@/lib/utils/document'
import { isPlainAddress, parseEmailList } from '@/lib/templates'
import { createClient } from '@/lib/supabase/client'
import { logEvent } from '@/lib/events'
import { useT } from '@/lib/i18n/client'
import type { TFn } from '@/lib/i18n'
import type { ReminderDraft } from '@/types'

interface Props {
  documentId: string
  reminderSentAt: string | null
  reminderLevel: number
  maxLevel: number
  gmailConfigured: boolean
}

type Fields = { to: string; cc: string; bcc: string; subject: string; body: string }
type Busy = 'loading' | 'sending' | 'mailto' | 'recording' | null

const ERROR_CODES = ['not_remindable', 'nothing_outstanding', 'no_email', 'invalid_address', 'pdf_failed'] as const

function reportError(t: TFn, payload: unknown, prefix: string) {
  const code = ERROR_CODES.find(c => c === (payload as { code?: unknown } | null)?.code)
  if (code) toast.error(`${prefix}${t(`dunning.errors.${code}`)}`)
  else toastApiError(t, payload, prefix, t('common.failed'))
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

const inputCls = 'w-full text-base md:text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400 aria-invalid:border-red-500'
const labelCls = 'text-xs font-medium text-neutral-500 dark:text-neutral-400'

// Every reminder is reviewed first. With Gmail it is sent from here with the Mahnung and the
// invoice copy attached; without (or by choice) the Mahnung PDF is downloaded, the email app opens
// prefilled, and "Mark reminder as sent" records it so the next reminder moves up a level.
export default function ReminderButton({ documentId, reminderSentAt, reminderLevel, maxLevel, gmailConfigured }: Props) {
  const [sentAt, setSentAt] = useState(reminderSentAt)
  const [level, setLevel] = useState(reminderLevel)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ReminderDraft | null>(null)
  const [fields, setFields] = useState<Fields>({ to: '', cc: '', bcc: '', subject: '', body: '' })
  const [busy, setBusy] = useState<Busy>(null)
  const [mailtoOpened, setMailtoOpened] = useState(false)
  const router = useRouter()
  const { t, lang } = useT()
  const uid = useId()

  const nextTitle = reminderTitle(nextReminderLevel(level, maxLevel), lang)
  const gmail = draft?.gmail ?? gmailConfigured
  const pdfUrl = draft ? `/api/invoices/${documentId}/reminder/pdf?level=${draft.level}` : ''
  const ccInvalid = parseEmailList(fields.cc).invalid
  const bccInvalid = parseEmailList(fields.bcc).invalid
  const addressesValid = !ccInvalid.length && !bccInvalid.length

  async function openDialog() {
    setOpen(true)
    setDraft(null)
    setMailtoOpened(false)
    setBusy('loading')
    try {
      const res = await fetch(`/api/invoices/${documentId}/reminder`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { reportError(t, data, t('dunning.couldNotPrepare')); setOpen(false); return }
      const next = data as ReminderDraft
      setDraft(next)
      setFields({ to: next.to, cc: next.cc.join(', '), bcc: '', subject: next.subject, body: next.body })
    } catch {
      toast.error(`${t('dunning.couldNotPrepare')}${t('common.unknownError')}`)
      setOpen(false)
    } finally {
      setBusy(null)
    }
  }

  // Loading the draft can be abandoned; sending or recording cannot.
  const locked = busy !== null && busy !== 'loading'

  function close() {
    if (locked) return
    setOpen(false)
  }

  async function record(mode: 'gmail' | 'manual') {
    if (!draft) return
    setBusy(mode === 'gmail' ? 'sending' : 'recording')
    try {
      const res = await fetch(`/api/invoices/${documentId}/reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          to: fields.to.trim(),
          cc: fields.cc,
          ...(mode === 'gmail' ? { bcc: fields.bcc, body: fields.body } : {}),
          subject: fields.subject,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        reportError(t, data, mode === 'gmail' ? t('reminders.couldNotSend') : t('dunning.couldNotRecord'))
        return
      }
      setSentAt(data.sentAt)
      setLevel(data.level)
      const title = reminderTitle(data.level, lang)
      toast.success(mode === 'gmail' ? t('reminders.sent', { title }) : t('dunning.recorded', { title }))
      setOpen(false)
      router.refresh()
    } catch {
      toast.error(`${mode === 'gmail' ? t('reminders.couldNotSend') : t('dunning.couldNotRecord')}${t('common.unknownError')}`)
    } finally {
      setBusy(null)
    }
  }

  async function openEmailApp() {
    if (!draft) return
    setBusy('mailto')
    try {
      // The email promises the invoice copy too: the same copy the Gmail send attaches.
      const [mahnung, copy] = await Promise.all([
        fetch(pdfUrl),
        fetch(`/api/documents/${documentId}/pdf?for=reminder`).catch(() => null),
      ])
      if (!mahnung.ok) {
        reportError(t, await mahnung.json().catch(() => ({})), t('dunning.couldNotPrepare'))
        return
      }
      download(await mahnung.blob(), draft.attachments[0])
      const copyBlob = copy?.ok ? await copy.blob().catch(() => null) : null
      if (copyBlob) download(copyBlob, draft.attachments[1])
      else toast.warning(t('dunning.invoiceCopyFailed'))

      const cc = parseEmailList(fields.cc).emails
      const query = [
        ...(cc.length ? [`cc=${encodeURIComponent(cc.join(','))}`] : []),
        `subject=${encodeURIComponent(fields.subject)}`,
        `body=${encodeURIComponent(fields.body)}`,
      ].join('&')
      const to = isPlainAddress(fields.to.trim()) ? fields.to.trim() : ''
      Object.assign(document.createElement('a'), { href: `mailto:${to}?${query}` }).click()
      setMailtoOpened(true)
      await logEvent(createClient(), documentId, 'mailto_opened', { to: fields.to.trim(), subject: fields.subject, level: draft.level })
    } catch (e) {
      toast.error(t('dunning.pdfFailed', { error: e instanceof Error ? e.message : t('common.unknownError') }))
    } finally {
      setBusy(null)
    }
  }

  const trigger = sentAt ? (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
        <BellRing size={13} aria-hidden="true" />
        <span className="sm:hidden">{t('reminders.sentShort', { date: new Date(sentAt).toLocaleDateString(lang === 'de' ? 'de-AT' : 'en-GB', { day: '2-digit', month: '2-digit' }) })}</span>
        <span className="hidden sm:inline">{t('reminders.sentLong', { title: reminderTitle(level, lang), date: formatDate(sentAt, lang) })}</span>
      </span>
      <button
        type="button"
        onClick={openDialog}
        disabled={!!busy}
        title={t('reminders.sendNextTitle', { title: nextTitle, date: formatDate(sentAt, lang) })}
        className="text-xs px-2 py-2 -my-2 rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors disabled:opacity-50"
      >
        {gmailConfigured ? t('reminders.sendNext', { title: nextTitle }) : t('dunning.prepareNext', { title: nextTitle })}
      </button>
    </div>
  ) : (
    <button
      type="button"
      onClick={openDialog}
      disabled={!!busy}
      className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
    >
      <Bell size={14} aria-hidden="true" />
      <span className="sr-only sm:not-sr-only">{gmailConfigured ? t('reminders.sendNext', { title: nextTitle }) : t('dunning.prepareNext', { title: nextTitle })}</span>
    </button>
  )

  return (
    <>
      {trigger}
      <Dialog
        open={open}
        onClose={close}
        title={draft ? t('dunning.dialogTitle', { title: draft.title, number: draft.number }) : nextTitle}
        busy={locked}
        panelClassName="max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        {!draft ? (
          <>
            <p className="text-sm text-neutral-500 dark:text-neutral-400" role="status">{t('dunning.loading')}</p>
            <div className="flex justify-end">
              <Button type="button" variant="ghost" onClick={close}>{t('common.cancel')}</Button>
            </div>
          </>
        ) : (
          <>
            {!gmail && <p className="text-xs text-amber-700 dark:text-amber-400">{t('dunning.noGmail')}</p>}
            <div className="space-y-3">
              <div className="space-y-1">
                <label htmlFor={`${uid}-to`} className={labelCls}>{t('dunning.to')}</label>
                <input id={`${uid}-to`} type="email" inputMode="email" autoComplete="off" value={fields.to}
                  onChange={e => setFields(f => ({ ...f, to: e.target.value }))} className={inputCls} />
              </div>
              <div className={`grid grid-cols-1 gap-3 ${gmail ? 'sm:grid-cols-2' : ''}`}>
                {(gmail ? (['cc', 'bcc'] as const) : (['cc'] as const)).map(field => {
                  const invalid = field === 'cc' ? ccInvalid : bccInvalid
                  return (
                    <div key={field} className="space-y-1 min-w-0">
                      <label htmlFor={`${uid}-${field}`} className={labelCls}>{t(`dunning.${field}`)}</label>
                      <input id={`${uid}-${field}`} type="text" inputMode="email" autoComplete="off" value={fields[field]}
                        onChange={e => setFields(f => ({ ...f, [field]: e.target.value }))}
                        aria-invalid={invalid.length > 0 || undefined} aria-describedby={`${uid}-${field}-hint`} className={inputCls} />
                      <p id={`${uid}-${field}-hint`} className={`text-xs ${invalid.length ? 'text-red-600 dark:text-red-400' : 'text-neutral-500 dark:text-neutral-400'}`}>
                        {invalid.length ? t('dunning.invalidAddresses', { list: invalid.join(', ') }) : t('dunning.addressesHint')}
                      </p>
                    </div>
                  )
                })}
              </div>
              <div className="space-y-1">
                <label htmlFor={`${uid}-subject`} className={labelCls}>{t('dunning.subject')}</label>
                <input id={`${uid}-subject`} value={fields.subject} onChange={e => setFields(f => ({ ...f, subject: e.target.value }))} className={inputCls} />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${uid}-body`} className={labelCls}>{t('dunning.body')}</label>
                <textarea id={`${uid}-body`} value={fields.body} onChange={e => setFields(f => ({ ...f, body: e.target.value }))} rows={10}
                  className={`${inputCls} py-2 resize-y`} />
              </div>
              <div className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                <p className="break-words">{t('dunning.attachments', { files: draft.attachments.join(', ') })}</p>
                <a href={pdfUrl} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 w-fit py-1 underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-200">
                  <FileText size={13} aria-hidden="true" />
                  {t('dunning.viewPdf', { title: draft.title })}
                </a>
              </div>
            </div>
            {mailtoOpened && <p className="text-xs text-neutral-600 dark:text-neutral-300" role="status">{t('dunning.markSentHint')}</p>}
            <div className="flex flex-col-reverse sm:flex-row sm:flex-wrap sm:justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close} disabled={!!busy}>{t('common.cancel')}</Button>
              <Button type="button" variant={mailtoOpened ? 'default' : 'outline'} onClick={() => record('manual')} disabled={!!busy || !addressesValid}>
                {busy === 'recording' ? t('common.saving') : t('dunning.markSent')}
              </Button>
              <Button type="button" variant={gmail || mailtoOpened ? 'outline' : 'default'} onClick={openEmailApp} disabled={!!busy || !addressesValid}>
                {busy === 'mailto' ? t('dunning.loading') : t('dunning.openEmailApp')}
              </Button>
              {gmail && (
                <Button type="button" variant={mailtoOpened ? 'outline' : 'default'} onClick={() => record('gmail')}
                  disabled={!!busy || !addressesValid || !fields.to.trim()}>
                  {busy === 'sending' ? t('common.sending') : t('dunning.sendGmail')}
                </Button>
              )}
            </div>
          </>
        )}
      </Dialog>
    </>
  )
}
