'use client'

import { useState } from 'react'
import { Link2, Check, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'

interface Props {
  documentId: string
  initialToken: string | null
}

export default function ShareLinkButton({ documentId, initialToken }: Props) {
  const [token, setToken] = useState<string | null>(initialToken)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const portalUrl = token
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/portal/${token}`
    : null

  async function generateLink() {
    setLoading(true)
    try {
      const res = await fetch(`/api/documents/${documentId}/share`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setToken(data.token)
      setOpen(true)
    } catch (e) {
      toast.error('Failed to generate link')
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
      setOpen(false)
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

  if (!open && !token) {
    return (
      <button
        onClick={generateLink}
        disabled={loading}
        title="Share"
        className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
      >
        {loading ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}
      </button>
    )
  }

  if (token && !open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Share link active"
        className="p-1.5 rounded-md text-blue-500 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors"
      >
        <Link2 size={15} />
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div
        className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 shadow-xl p-5 max-w-sm w-full mx-4 space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-neutral-900 dark:text-neutral-100 text-sm">Share link</h3>
          <button onClick={() => setOpen(false)} className="p-1 rounded-md text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors">
            <X size={14} />
          </button>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Anyone with this link can view the document and download the PDF. No login required.
        </p>
        <div className="flex gap-2">
          <input
            readOnly
            value={portalUrl ?? ''}
            className="flex-1 text-xs bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md px-2.5 py-1.5 text-neutral-700 dark:text-neutral-300 font-mono truncate"
          />
          <button
            onClick={copyLink}
            className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-1.5 bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded-md hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors"
          >
            {copied ? <Check size={12} /> : null}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="flex justify-end pt-1">
          <button
            onClick={revokeLink}
            disabled={loading}
            className="text-xs text-red-500 hover:text-red-700 transition-colors disabled:opacity-50"
          >
            {loading ? 'Revoking…' : 'Revoke link'}
          </button>
        </div>
      </div>
    </div>
  )
}
