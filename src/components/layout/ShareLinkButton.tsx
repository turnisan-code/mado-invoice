'use client'

import { useState } from 'react'
import { Link2, Check, Loader2, X, HardDrive, Eye, EyeOff, Clock, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { toastApiError } from '@/lib/google/toast'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { useT } from '@/lib/i18n/client'
import { formatDate } from '@/lib/utils/document'
import { isShareExpired } from '@/lib/share'
import { docTitle, documentLanguage, documentT } from '@/lib/document-labels'
import type { DocumentKind } from '@/types'

interface Props {
  documentId: string
  number: string
  // What the portal calls it: a Storno credit note is shared as a Storno.
  kind: DocumentKind
  language: string | null | undefined
  initialToken: string | null
  // Saving to Drive needs Google connected and a Drive folder chosen.
  driveReady: boolean
}

type ShareState = { token: string | null; expiresAt: string | null; viewedAt: string | null }

const smallBtn = 'text-xs px-2.5 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50'
const actionBtn = 'inline-flex items-center gap-1.5 text-sm px-3 min-h-11 sm:min-h-9 rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50'

export default function ShareLinkButton({ documentId, number, kind, language, initialToken, driveReady }: Props) {
  const [share, setShare] = useState<ShareState>({ token: initialToken, expiresAt: null, viewedAt: null })
  const [details, setDetails] = useState(false)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<'revoke' | 'rotate' | null>(null)
  const [copied, setCopied] = useState(false)
  const [driveUploading, setDriveUploading] = useState(false)
  const { t, lang } = useT()

  const token = share.token
  const portalUrl = token
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/portal/${token}`
    : null
  const expired = isShareExpired(share.expiresAt)
  // Only rendered inside the open dialog, so server and first client render agree.
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  // The share sheet's title is in the document's language, like the portal page it opens.
  const shareTitle = `${docTitle(documentT(documentLanguage(language)), kind)} ${number}`

  function close() {
    setOpen(false)
    setConfirm(null)
  }

  async function shareRequest(method: 'GET' | 'POST' | 'PATCH', action?: 'extend' | 'rotate'): Promise<ShareState> {
    const res = await fetch(`/api/documents/${documentId}/share`, {
      method,
      ...(action ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) } : {}),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : '')
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
      toast.error(e instanceof Error && e.message ? e.message : t('share.generateFailed'))
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
    } catch {
      toast.error(t(action === 'rotate' ? 'pdfPortal.share.rotateFailed' : 'pdfPortal.share.extendFailed'))
    } finally {
      setLoading(false)
    }
  }

  async function revokeLink() {
    setLoading(true)
    try {
      const res = await fetch(`/api/documents/${documentId}/share`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to revoke')
      setShare({ token: null, expiresAt: null, viewedAt: null })
      setDetails(false)
      close()
      toast.success(t('share.revoked'))
    } catch {
      toast.error(t('share.revokeFailed'))
    } finally {
      setLoading(false)
    }
  }

  async function copyLink() {
    if (!portalUrl) return
    try {
      await navigator.clipboard.writeText(portalUrl)
    } catch {
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
    } catch (e) {
      toast.error(t('share.driveFailed', { error: e instanceof Error ? e.message : t('common.unknownError') }))
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
          className="h-9 w-9 flex items-center justify-center rounded-md text-blue-500 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors"
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
          className="h-9 w-9 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
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
            readOnly
            aria-label={t('share.urlLabel')}
            value={portalUrl ?? ''}
            className={`flex-1 min-w-0 text-xs bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md px-2.5 py-1.5 font-mono truncate ${expired ? 'text-neutral-400 dark:text-neutral-500 line-through' : 'text-neutral-700 dark:text-neutral-300'}`}
          />
          <button
            type="button"
            onClick={copyLink}
            className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-1.5 bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded-md hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors disabled:opacity-50"
          >
            {copied && <Check size={12} aria-hidden="true" />}
            {copied ? t('common.copied') : t('common.copy')}
          </button>
        </div>

        {(canShare || driveReady) && (
          <div className="flex flex-wrap gap-2">
            {canShare && (
              <button type="button" onClick={shareLink} disabled={busy} className={actionBtn}>
                <Share2 size={14} aria-hidden="true" />
                {t('share.share')}
              </button>
            )}
            {driveReady && (
              <button type="button" onClick={uploadToDrive} disabled={busy} className={actionBtn}>
                {driveUploading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <HardDrive size={14} aria-hidden="true" />}
                {driveUploading ? t('common.saving') : t('docs.share.saveToDrive')}
              </button>
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
              <button type="button" onClick={() => setConfirm(null)} disabled={busy} className={smallBtn}>
                {confirm === 'revoke' ? t('share.keepLink') : t('common.cancel')}
              </button>
              {confirm === 'revoke' ? (
                <button
                  type="button"
                  onClick={revokeLink}
                  disabled={busy}
                  className="text-xs px-2.5 py-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {loading ? t('share.revoking') : t('share.revokeLink')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => changeLink('rotate')}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors disabled:opacity-50"
                >
                  {loading && <Loader2 size={12} className="animate-spin" />}
                  {t('pdfPortal.share.rotateConfirm')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" onClick={() => changeLink('extend')} disabled={busy} className={smallBtn}>
              {t('pdfPortal.share.extend')}
            </button>
            <button type="button" onClick={() => setConfirm('rotate')} disabled={busy} className={smallBtn}>
              {t('pdfPortal.share.rotate')}
            </button>
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
