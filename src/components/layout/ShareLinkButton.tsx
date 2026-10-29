'use client'

import { useRef, useState } from 'react'
import { Link2, Check, Loader2, X, HardDrive, Eye, EyeOff, Clock, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { toastApiError } from '@/lib/google/toast'
import { knownApiError, requestErrorMessage } from '@/lib/api-errors'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { fieldClass } from '@/components/ui/control'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n/client'
import { formatDate } from '@/lib/utils/document'
import { isShareExpired } from '@/lib/share'
import { docTitle, documentLanguage, documentT } from '@/lib/document-labels'
import type { DocumentKind, InvoiceKind } from '@/types'

interface Props {
  documentId: string
  number: string
  // What the portal calls it: a Storno credit note is shared as a Storno, an advance, partial or
  // final invoice by its own title.
  kind: DocumentKind
  invoiceKind?: InvoiceKind | null
  language: string | null | undefined
  initialToken: string | null
  // Saving to Drive needs Google connected and a Drive folder chosen.
  driveReady: boolean
}

type ShareState = { token: string | null; expiresAt: string | null; viewedAt: string | null }

// Same size as the outline buttons next to it in the document header.
const triggerBtn = 'h-10 w-10 sm:h-8 sm:w-8 flex items-center justify-center rounded-md transition-colors'

export default function ShareLinkButton({ documentId, number, kind, invoiceKind, language, initialToken, driveReady }: Props) {
  const [share, setShare] = useState<ShareState>({ token: initialToken, expiresAt: null, viewedAt: null })
  const [details, setDetails] = useState(false)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<'revoke' | 'rotate' | null>(null)
  const [copied, setCopied] = useState(false)
  const [driveUploading, setDriveUploading] = useState(false)
  const urlRef = useRef<HTMLInputElement>(null)
  const { t, lang } = useT()

  const token = share.token
  const portalUrl = token
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/portal/${token}`
    : null
  const expired = isShareExpired(share.expiresAt)
  // Only rendered inside the open dialog, so server and first client render agree.
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  // The share sheet's title is in the document's language, like the portal page it opens.
  const shareTitle = `${docTitle(documentT(documentLanguage(language)), kind, invoiceKind)} ${number}`

  function close() {
    setOpen(false)
    setConfirm(null)
  }

  // Throws the failure already worded in the UI language.
  async function shareRequest(method: 'GET' | 'POST' | 'PATCH', action?: 'extend' | 'rotate'): Promise<ShareState> {
    let res: Response
    try {
      res = await fetch(`/api/documents/${documentId}/share`, {
        method,
        ...(action ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) } : {}),
      })
    } catch (err) {
      throw new Error(requestErrorMessage(t, err))
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(knownApiError(t, data) ?? '')
    return { token: data.token ?? null, expiresAt: data.expiresAt ?? null, viewedAt: data.viewedAt ?? null }
  }

  async function openDialog() {
    setOpen(true)
    if (details) return
    try {
      setShare(await shareRequest('GET'))
      setDetails(true)
    } catch {
      // The link itself still works; only its expiry and view status stay unknown.
    }
  }

  async function generateLink() {
    setLoading(true)
    try {
      setShare(await shareRequest('POST'))
      setDetails(true)
      setOpen(true)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? `${t('share.generateFailed')}: ${e.message}` : t('share.generateFailed'))
    } finally {
      setLoading(false)
    }
  }

  async function changeLink(action: 'extend' | 'rotate') {
    setLoading(true)
    try {
      const next = await shareRequest('PATCH', action)
      setShare(next)
      setDetails(true)
      setConfirm(null)
      setCopied(false)
      toast.success(action === 'rotate'
        ? t('pdfPortal.share.rotated')
        : t('pdfPortal.share.extended', { date: next.expiresAt ? formatDate(next.expiresAt, lang) : '' }))
    } catch (e) {
      const fallback = t(action === 'rotate' ? 'pdfPortal.share.rotateFailed' : 'pdfPortal.share.extendFailed')
      toast.error(e instanceof Error && e.message ? `${fallback}: ${e.message}` : fallback)
    } finally {
      setLoading(false)
    }
  }

  async function revokeLink() {
    setLoading(true)
    try {
      const res = await fetch(`/api/documents/${documentId}/share`, { method: 'DELETE' })
      if (!res.ok) {
        const reason = knownApiError(t, await res.json().catch(() => ({})))
        toast.error(reason ? `${t('share.revokeFailed')}: ${reason}` : t('share.revokeFailed'))
        return
      }
      setShare({ token: null, expiresAt: null, viewedAt: null })
      setDetails(false)
      close()
      toast.success(t('share.revoked'))
    } catch (err) {
      toast.error(`${t('share.revokeFailed')}: ${requestErrorMessage(t, err)}`)
    } finally {
      setLoading(false)
    }
  }

  // The Clipboard API is missing over plain http and can be refused; the link is then selected
  // in its field for copying by hand.
  async function copyLink() {
    if (!portalUrl) return
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(portalUrl)
    } catch {
      urlRef.current?.select()
      toast.error(t('messages.copyFailed'))
      return
    }
    setCopied(true)
    toast.success(t('share.linkCopied'))
    setTimeout(() => setCopied(false), 2000)
  }

  async function uploadToDrive() {
    setDriveUploading(true)
    try {
      const res = await fetch(`/api/documents/${documentId}/drive-pdf`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toastApiError(t, data, t('share.driveFailedPrefix'))
        return
      }
      toast.success(
        data.webViewLink
          ? <span>{t(data.existing ? 'archive.driveExisting' : 'share.savedToDrive')}<a href={data.webViewLink} target="_blank" rel="noopener" className="underline">{t('common.open')}</a></span>
          : t(data.existing ? 'archive.driveExistingPlain' : 'share.savedToDrivePlain'),
        { duration: 5000 }
      )
    } catch (err) {
      toast.error(t('share.driveFailed', { error: requestErrorMessage(t, err) }))
    } finally {
      setDriveUploading(false)
    }
  }

  async function shareLink() {
    if (!portalUrl) return
    try {
      await navigator.share({ title: shareTitle, url: portalUrl })
    } catch (e) {
      // Closing the share sheet is no failure; anything else (no target, not allowed) copies.
      if (e instanceof DOMException && e.name === 'AbortError') return
      await copyLink()
    }
  }

  const busy = loading || driveUploading

  return (
    <>
      {token ? (
        <button
          type="button"
          onClick={openDialog}
          title={t('share.active')}
          aria-label={t('share.activeAria')}
          className={`${triggerBtn} text-blue-500 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950`}
        >
          <Link2 size={15} />
        </button>
      ) : (
        <button
          type="button"
          onClick={generateLink}
          disabled={loading}
          title={t('share.share')}
          aria-label={t('share.share')}
          className={`${triggerBtn} text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50`}
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}
        </button>
      )}

      <Dialog
        open={open && !!token}
        onClose={close}
        title={t('share.title')}
        hideTitle
        busy={busy}
        panelClassName="p-5 space-y-3"
      >
        <div className="flex items-center justify-between">
          <span aria-hidden="true" className="font-semibold text-neutral-900 dark:text-neutral-100 text-sm">{t('share.title')}</span>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label={t('common.close')}
            className="h-11 w-11 -m-3 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {t('share.description')}
        </p>
        <div className="flex gap-2">
          <input
            ref={urlRef}
            readOnly
            aria-label={t('share.urlLabel')}
            value={portalUrl ?? ''}
            className={cn(fieldClass, 'flex-1 text-xs md:text-xs font-mono truncate bg-neutral-50 dark:bg-neutral-800', expired ? 'text-neutral-400 dark:text-neutral-500 line-through' : 'text-neutral-700 dark:text-neutral-300')}
          />
          <Button type="button" onClick={copyLink} className="shrink-0 text-xs">
            {copied && <Check size={12} aria-hidden="true" />}
            {copied ? t('common.copied') : t('common.copy')}
          </Button>
        </div>

        {(canShare || driveReady) && (
          <div className="flex flex-wrap gap-2">
            {canShare && (
              <Button type="button" variant="outline" onClick={shareLink} disabled={busy}>
                <Share2 size={14} aria-hidden="true" />
                {t('share.share')}
              </Button>
            )}
            {driveReady && (
              <Button type="button" variant="outline" onClick={uploadToDrive} disabled={busy}>
                {driveUploading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <HardDrive size={14} aria-hidden="true" />}
                {driveUploading ? t('common.saving') : t('docs.share.saveToDrive')}
              </Button>
            )}
          </div>
        )}

        {details && (
          <ul className="space-y-1 text-xs" aria-live="polite">
            {share.expiresAt && (
              <li className={`flex items-start gap-1.5 ${expired ? 'text-red-600 dark:text-red-400' : 'text-neutral-500 dark:text-neutral-400'}`}>
                <Clock size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                {t(expired ? 'pdfPortal.share.expiredOn' : 'pdfPortal.share.validUntil', { date: formatDate(share.expiresAt, lang) })}
              </li>
            )}
            <li className="flex items-start gap-1.5 text-neutral-500 dark:text-neutral-400">
              {share.viewedAt ? <Eye size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> : <EyeOff size={12} className="mt-0.5 shrink-0" aria-hidden="true" />}
              {share.viewedAt ? t('pdfPortal.share.viewed', { date: formatDate(share.viewedAt, lang) }) : t('pdfPortal.share.notViewed')}
            </li>
          </ul>
        )}

        {confirm ? (
          <div className={`rounded-lg border p-3 space-y-2 ${confirm === 'revoke' ? 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30' : 'border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50'}`}>
            <p className={`text-xs ${confirm === 'revoke' ? 'text-red-700 dark:text-red-300' : 'text-neutral-700 dark:text-neutral-300'}`}>
              {confirm === 'revoke' ? t('share.revokeQuestion') : t('pdfPortal.share.rotateQuestion')}
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setConfirm(null)} disabled={busy} className="text-xs">
                {confirm === 'revoke' ? t('share.keepLink') : t('common.cancel')}
              </Button>
              {confirm === 'revoke' ? (
                <Button
                  type="button"
                  onClick={revokeLink}
                  disabled={busy}
                  className="text-xs bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/40"
                >
                  {loading ? t('share.revoking') : t('share.revokeLink')}
                </Button>
              ) : (
                <Button type="button" onClick={() => changeLink('rotate')} disabled={busy} className="text-xs">
                  {loading && <Loader2 size={12} className="animate-spin" />}
                  {t('pdfPortal.share.rotateConfirm')}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => changeLink('extend')} disabled={busy} className="text-xs">
              {t('pdfPortal.share.extend')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirm('rotate')} disabled={busy} className="text-xs">
              {t('pdfPortal.share.rotate')}
            </Button>
            <button
              type="button"
              onClick={() => setConfirm('revoke')}
              disabled={busy}
              className="ml-auto text-xs px-2 py-2 -my-2 rounded-md text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors disabled:opacity-50"
            >
              {t('share.revokeLink')}
            </button>
          </div>
        )}
      </Dialog>
    </>
  )
}
