'use client'

import { useEffect } from 'react'
import { createPortal } from 'react-dom'

export type PopoverAnchor = { top?: number; bottom?: number; right: number; opener: HTMLElement }

// Below the button, or above it when the popover would run off the bottom of the screen.
export function anchorTo(button: HTMLElement, height: number): PopoverAnchor {
  const rect = button.getBoundingClientRect()
  const right = Math.max(8, window.innerWidth - rect.right)
  return rect.bottom + height > window.innerHeight
    ? { bottom: window.innerHeight - rect.top + 4, right, opener: button }
    : { top: rect.bottom + 4, right, opener: button }
}

// A small dialog next to a line's button (service date, discount). A tap outside or Escape
// closes it, and focus returns to the button that opened it.
export function AnchoredPopover({ anchor, label, onClose, children }: {
  anchor: PopoverAnchor
  label: string
  onClose: () => void
  children: React.ReactNode
}) {
  const { opener, ...position } = anchor
  useEffect(() => () => { if (opener.isConnected) opener.focus({ preventScroll: true }) }, [opener])
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="dialog"
        aria-label={label}
        className="fixed z-50 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg p-3 space-y-2"
        style={position}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
      >
        {children}
      </div>
    </>,
    document.body,
  )
}
