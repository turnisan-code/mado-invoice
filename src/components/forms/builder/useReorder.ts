'use client'

import { useState } from 'react'
import type { DropEdge } from './model'

interface Options {
  // Dropping `from` on that edge of `over` would leave the order as it is: no indicator then.
  isNoop: (from: string, over: string, edge: DropEdge) => boolean
  canDrop?: (from: string, over: string) => boolean
  onDrop: (from: string, over: string, edge: DropEdge) => void
  // Alt+ArrowUp/Down on a handle.
  onStep: (id: string, delta: -1 | 1) => void
}

// Drag and drop by a row's handle, with the drop landing exactly where the indicator line is
// drawn (above or below the row under the pointer), plus keyboard moves on the same handle.
// Rows carry data-reorder-row so the whole row is the drag image.
export function useReorder({ isNoop, canDrop, onDrop, onStep }: Options) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [indicator, setIndicator] = useState<{ id: string; edge: DropEdge } | null>(null)
  const [announcement, setAnnouncement] = useState('')

  function end() {
    setDragging(null)
    setIndicator(null)
  }

  const handleProps = (id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent<HTMLElement>) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', id)
      const row = e.currentTarget.closest<HTMLElement>('[data-reorder-row]')
      if (row) {
        const rect = row.getBoundingClientRect()
        e.dataTransfer.setDragImage(row, e.clientX - rect.left, e.clientY - rect.top)
      }
      setDragging(id)
    },
    onDragEnd: end,
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      e.preventDefault()
      onStep(id, e.key === 'ArrowUp' ? -1 : 1)
    },
  })

  const rowProps = (id: string) => ({
    'data-reorder-row': true,
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!dragging || (canDrop && !canDrop(dragging, id))) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const rect = e.currentTarget.getBoundingClientRect()
      const edge: DropEdge = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
      const next = isNoop(dragging, id, edge) ? null : { id, edge }
      if (next?.id !== indicator?.id || next?.edge !== indicator?.edge) setIndicator(next)
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      if (!dragging) return
      e.preventDefault()
      if (indicator?.id === id) onDrop(dragging, id, indicator.edge)
      end()
    },
  })

  // An inset shadow, so showing the indicator never shifts the rows.
  const indicatorCls = (id: string) => indicator?.id !== id ? ''
    : indicator.edge === 'before' ? 'shadow-[inset_0_2px_0_0_var(--color-blue-400)]' : 'shadow-[inset_0_-2px_0_0_var(--color-blue-400)]'

  return { dragging, handleProps, rowProps, indicatorCls, announcement, announce: setAnnouncement }
}
