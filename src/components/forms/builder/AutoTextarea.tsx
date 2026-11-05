'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

function fit(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
}

// A textarea that grows with its text (line breaks are kept), starting at one line.
export function AutoTextarea({ className, value, ref, ...props }: React.ComponentProps<'textarea'> & { value: string }) {
  const own = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => fit(own.current), [value])
  useEffect(() => {
    const onResize = () => fit(own.current)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return (
    <textarea
      {...props}
      ref={el => {
        own.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) ref.current = el
      }}
      rows={1}
      value={value}
      className={cn('resize-none overflow-hidden', className)}
    />
  )
}
