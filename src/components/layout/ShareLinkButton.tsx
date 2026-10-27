'use client'

import { useState } from 'react'
import { Link2, Check, Loader2, X, HardDrive } from 'lucide-react'
import { toast } from 'sonner'
import { toastApiError } from '@/lib/google/toast'
import { Dialog } from '@/components/ui/ConfirmDialog'

interface Props {
  documentId: string
  initialToken: string | null
  driveConfigured: boolean
}

export default function ShareLinkButton({ documentId, initialToken, driveConfigured }: Props) {
  const [token, setToken] = useState<string | null>(initialToken)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saveToDrive, setSaveToDrive] = useState(driveConfigured)
  const [driveUploading, setDriveUploading] = useState(false)

  const portalUrl = token
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/portal/${token}`
    : null

  function close() {
    setOpen(false)
    setConfirmRevoke(false)
  }

  async function generateLink() {
    setLoading(true)
    try {
      const res = await fetch(`/api/documents/${documentId}/share`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setToken(data.token)
      setOpen(true)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Failed to generate link')
    } finally {
      setLoading(false)
    }
  }

  async function revokeLink() {
    setLoading(true)
    try {
      const res = await fetch(`/api/documents/${documentId}/share`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to revoke')
      setToken(null)
      close()
      toast.success('Share link revoked')
    } catch {
      toast.error('Failed to revoke link')
    } finally {
      setLoading(false)
    }
  }

  async function copyLink() {
    if (!portalUrl) return
    await navigator.clipboard.writeText(portalUrl)
    setCopied(true)
    toast.success('Link copied')
    setTimeout(() => setCopied(false), 2000)
  }

  async function uploadToDrive() {
    setDriveUploading(true)
    try {
      const res = await fetch(`/api/documents/${documentId}/drive-pdf`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toastApiError(data, 'Drive upload failed: ')
        return
      }
      toast.success(
        data.webViewLink
          ? <span>Saved to Drive — <a href={data.webViewLink} target="_blank" rel="noopener" className="underline">open</a></span>
          : 'Saved to Google Drive.',
        { duration: 5000 }
      )
    } catch (e) {
      toast.error(`Drive upload failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    } finally {
      setDriveUploading(false)
    }
  }

  async function handleCopyWithDrive() {
    await copyLink()
    if (saveToDrive && driveConfigured) {
      await uploadToDrive()
    }
  }

  const busy = loading || driveUploading

  return (
    <>
      {token ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Share link active"
          aria-label="Share link active — open sharing options"
          className="h-9 w-9 flex items-center justify-center rounded-md text-blue-500 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors"
        >
          <Link2 size={15} />
        </button>
      ) : (
        <button
          type="button"
          onClick={generateLink}
          disabled={loading}
          title="Share"
          aria-label="Share"
          className="h-9 w-9 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}
        </button>
      )}

      <Dialog
        open={open && !!token}
        onClose={close}
        title="Share link"
        hideTitle
        busy={busy}
        panelClassName="p-5 space-y-3"
      >
        <div className="flex items-center justify-between">
          <span aria-hidden="true" className="font-semibold text-neutral-900 dark:text-neutral-100 text-sm">Share link</span>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="Close"
            className="h-11 w-11 -m-3 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Anyone with this link can view the document and download the PDF. No login required.
        </p>
        <div className="flex gap-2">
          <input
            readOnly
            aria-label="Share link URL"
            value={portalUrl ?? ''}
            className="flex-1 min-w-0 text-xs bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md px-2.5 py-1.5 text-neutral-700 dark:text-neutral-300 font-mono truncate"
          />
          <button
            type="button"
            onClick={handleCopyWithDrive}
            disabled={driveUploading}
            className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-1.5 bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded-md hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors disabled:opacity-50"
          >
            {driveUploading ? <Loader2 size={12} className="animate-spin" /> : copied ? <Check size={12} /> : null}
            {driveUploading ? 'Saving…' : copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        {driveConfigured && (
          <label className="flex items-center gap-2.5 text-sm text-neutral-700 dark:text-neutral-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={saveToDrive}
              onChange={e => setSaveToDrive(e.target.checked)}
              className="w-4 h-4 rounded border-neutral-300 dark:border-neutral-600 accent-neutral-900 dark:accent-white"
            />
            <HardDrive size={13} className="text-neutral-500 dark:text-neutral-400" aria-hidden="true" />
            Also save to Google Drive
          </label>
        )}

        {confirmRevoke ? (
          <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3 space-y-2">
            <p className="text-xs text-red-700 dark:text-red-300">Revoke this link? Anyone who has it loses access to the document.</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRevoke(false)}
                disabled={busy}
                className="text-xs px-2.5 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-white dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
              >
                Keep link
              </button>
              <button
                type="button"
                onClick={revokeLink}
                disabled={busy}
                className="text-xs px-2.5 py-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {loading ? 'Revoking…' : 'Revoke link'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => setConfirmRevoke(true)}
              disabled={busy}
              className="text-xs px-2 py-2 -my-2 rounded-md text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors disabled:opacity-50"
            >
              Revoke link
            </button>
          </div>
        )}
      </Dialog>
    </>
  )
}
