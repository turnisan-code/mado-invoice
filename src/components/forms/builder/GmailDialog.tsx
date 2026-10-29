'use client'

import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { controlClass, fieldClass } from '@/components/ui/control'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { parseEmailList } from '@/lib/templates'
import { useT } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'
import type { EInvoiceFormat } from '@/types'

export type GmailPreview = {
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  pdfBase64: string
  filename: string
  documentId: string
  newDocId?: string
  uploadToDrive: boolean
  driveArchived: boolean
  // The client's e-invoice format; null when none is set or the document cannot be one.
  einvoiceFormat: EInvoiceFormat | null
  attachEInvoice: boolean
  // Issued and current total (formatted) when they differ: the PDF is frozen, the XML is not.
  totalChange: { issued: string; current: string } | null
  // Why the last attempt could not build the e-invoice; nothing was sent.
  einvoiceError: string | null
}

const checkboxCls = 'w-4 h-4 rounded border-neutral-300 dark:border-neutral-600 accent-neutral-900 dark:accent-white'

// The email as it will be sent, editable, with the issued PDF (and the client's e-invoice) attached.
export function GmailDialog({ preview, setPreview, sending, driveConfigured, onClose, onSend }: {
  preview: GmailPreview | null
  setPreview: (fn: (p: GmailPreview | null) => GmailPreview | null) => void
  sending: boolean
  driveConfigured: boolean
  onClose: () => void
  onSend: () => void
}) {
  const { t } = useT()
  const uid = useId()
  const edit = (patch: Partial<GmailPreview>) => setPreview(p => p ? { ...p, ...patch } : p)
  return (
    <Dialog open={!!preview} onClose={onClose} title={t('builder.reviewEmail')} busy={sending} panelClassName="max-w-lg">
      {preview && (
        <>
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor={`${uid}-to`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('builder.to')}</label>
              <input id={`${uid}-to`} type="email" value={preview.to} onChange={e => edit({ to: e.target.value })} className={fieldClass} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(['cc', 'bcc'] as const).map(field => {
                const invalid = parseEmailList(preview[field]).invalid
                return (
                  <div key={field} className="space-y-1 min-w-0">
                    <label htmlFor={`${uid}-${field}`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t(`dunning.${field}`)}</label>
                    <input
                      id={`${uid}-${field}`}
                      type="text"
                      inputMode="email"
                      autoComplete="off"
                      value={preview[field]}
                      onChange={e => edit({ [field]: e.target.value })}
                      aria-invalid={invalid.length > 0 || undefined}
                      aria-describedby={`${uid}-${field}-hint`}
                      className={fieldClass}
                    />
                    <p id={`${uid}-${field}-hint`} className={`text-xs ${invalid.length ? 'text-red-600 dark:text-red-400' : 'text-neutral-500 dark:text-neutral-400'}`}>
                      {invalid.length ? t('dunning.invalidAddresses', { list: invalid.join(', ') }) : t('dunning.addressesHint')}
                    </p>
                  </div>
                )
              })}
            </div>
            <div className="space-y-1">
              <label htmlFor={`${uid}-subject`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('builder.subject')}</label>
              <input id={`${uid}-subject`} value={preview.subject} onChange={e => edit({ subject: e.target.value })} className={fieldClass} />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${uid}-body`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('builder.body')}</label>
              <textarea id={`${uid}-body`} value={preview.body} onChange={e => edit({ body: e.target.value })} rows={7}
                className={cn(controlClass, 'py-2 resize-none')} />
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('builder.pdfAttached', { filename: preview.filename })}</p>
          </div>
          {preview.einvoiceFormat && (
            <div className="space-y-1">
              <label className="flex items-center gap-2.5 text-sm text-neutral-700 dark:text-neutral-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={preview.attachEInvoice}
                  onChange={e => edit({ attachEInvoice: e.target.checked, einvoiceError: null })}
                  aria-describedby={[`${uid}-einvoice-hint`, preview.totalChange && `${uid}-einvoice-total`, preview.einvoiceError && `${uid}-einvoice-error`].filter(Boolean).join(' ')}
                  className={checkboxCls}
                />
                {t('print.gmail.attachEInvoice', { format: t(`einvoice.formats.${preview.einvoiceFormat}`) })}
              </label>
              <p id={`${uid}-einvoice-hint`} className="text-xs text-neutral-500 dark:text-neutral-400 pl-6.5">{t('print.gmail.attachEInvoiceHint')}</p>
              {preview.totalChange && (
                <p id={`${uid}-einvoice-total`} className="text-xs text-amber-700 dark:text-amber-400 pl-6.5">{t('print.issuedTotal.einvoice', preview.totalChange)}</p>
              )}
              {preview.einvoiceError && (
                <p id={`${uid}-einvoice-error`} role="alert" className="text-xs text-red-600 dark:text-red-400 pl-6.5">
                  {t('print.gmail.einvoiceFailed', { reason: preview.einvoiceError })} {t('print.gmail.sendWithout')}
                </p>
              )}
            </div>
          )}
          {driveConfigured && (preview.driveArchived ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('builder.archivedToDrive')}</p>
          ) : (
            <label className="flex items-center gap-2.5 text-sm text-neutral-700 dark:text-neutral-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={preview.uploadToDrive}
                onChange={e => edit({ uploadToDrive: e.target.checked })}
                className={checkboxCls}
              />
              {t('builder.alsoDrive')}
            </label>
          ))}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={sending}>{t('common.cancel')}</Button>
            <Button type="button" onClick={onSend} disabled={sending || parseEmailList([preview.cc, preview.bcc]).invalid.length > 0}>
              {sending ? t('common.sending') : t('common.send')}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
