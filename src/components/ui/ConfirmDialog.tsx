'use client'

import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n/client'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  description?: React.ReactNode
  /** While busy, Escape and the backdrop do not close the dialog. */
  busy?: boolean
  align?: 'center' | 'bottom'
  panelClassName?: string
  /** Element to focus on open; defaults to the first focusable control. */
  initialFocus?: React.RefObject<HTMLElement | null>
  hideTitle?: boolean
  /** Render in place instead of in document.body (needed inside the portal's `.light` wrapper). */
  portal?: boolean
  children?: React.ReactNode
}

// Accessible modal shell: role=dialog, focus moved in on open and restored on close,
// Tab kept inside, Escape and backdrop close. Styled with theme tokens only, so it also
// renders light inside the portal's `.light` wrapper.
export function Dialog({ open, onClose, title, description, busy = false, align = 'center', panelClassName, initialFocus, hideTitle = false, portal = true, children }: DialogProps) {
  const titleId = useId()
  const descId = useId()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const target = initialFocus?.current ?? panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel
    target?.focus({ preventScroll: true })
    return () => { previous?.focus({ preventScroll: true }) }
  }, [open, initialFocus])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (!busy) onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) { e.preventDefault(); panelRef.current.focus(); return }
      const first = items[0], last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onClose])

  if (!open || typeof document === 'undefined') return null

  const node = (
    <div
      className={cn('fixed inset-0 z-50 flex bg-black/40 backdrop-blur-sm', align === 'bottom' ? 'items-end' : 'items-center justify-center p-4')}
      onPointerDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          'bg-popover text-popover-foreground border border-border shadow-xl outline-none',
          align === 'bottom' ? 'w-full rounded-t-2xl' : 'w-full max-w-sm rounded-xl p-6 space-y-4',
          panelClassName,
        )}
      >
        {align === 'bottom' ? (
          <>
            <h2 id={titleId} className={hideTitle ? 'sr-only' : 'font-semibold'}>{title}</h2>
            {description && <p id={descId} className={hideTitle ? 'sr-only' : 'text-sm text-muted-foreground'}>{description}</p>}
            {children}
          </>
        ) : (
          <>
            <div className={cn(hideTitle && 'sr-only')}>
              <h2 id={titleId} className="font-semibold">{title}</h2>
              {description && <p id={descId} className="text-sm text-muted-foreground mt-1">{description}</p>}
            </div>
            {children}
          </>
        )}
      </div>
    </div>
  )
  return portal ? createPortal(node, document.body) : node
}

export interface ConfirmDialogProps {
  open: boolean
  title: React.ReactNode
  description?: React.ReactNode
  confirmLabel?: React.ReactNode
  cancelLabel?: React.ReactNode
  destructive?: boolean
  /** Disables both buttons and blocks Escape/backdrop while the action runs. */
  busy?: boolean
  portal?: boolean
  onConfirm: () => void
  onCancel: () => void
  children?: React.ReactNode
}

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel, destructive = false, busy = false, portal, onConfirm, onCancel, children }: ConfirmDialogProps) {
  const { t } = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={open} onClose={onCancel} title={title} description={description} busy={busy} initialFocus={cancelRef} portal={portal}>
      {children}
      <div className="flex gap-2 justify-end">
        <Button ref={cancelRef} type="button" variant="outline" onClick={onCancel} disabled={busy}>{cancelLabel ?? t('dialogs.cancel')}</Button>
        <Button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={cn(destructive && 'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/40')}
        >
          {confirmLabel ?? t('dialogs.confirm')}
        </Button>
      </div>
    </Dialog>
  )
}

export default ConfirmDialog
