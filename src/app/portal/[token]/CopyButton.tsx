'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'

// The labels come from the page, in the document's language.
export default function CopyButton({ value, label, copiedLabel, failedLabel }: { value: string; label: string; copiedLabel: string; failedLabel: string }) {
  const [copied, setCopied] = useState(false)

  // Without clipboard access (plain http, a refused permission) the value shown next to the
  // button is selected for copying by hand, and the hint says so.
  async function copy(event: React.MouseEvent<HTMLButtonElement>) {
    const shown = event.currentTarget.previousElementSibling
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(value)
    } catch {
      if (shown) window.getSelection()?.selectAllChildren(shown)
      toast.error(failedLabel)
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={label}
      className="h-11 w-11 -my-3 -mr-3 shrink-0 inline-flex items-center justify-center rounded-md text-blue-500 hover:text-blue-800 transition-colors"
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span className="sr-only" aria-live="polite">{copied ? copiedLabel : ''}</span>
    </button>
  )
}
