'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'

type Props = Omit<React.ComponentProps<'input'>, 'type' | 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
}

// A date field that reports only complete dates or an intentional clear. While a date is being
// typed the browser reports an empty value; passing that on would let the autosave write it.
// An unfinished entry is put back to the last date when the field is left.
export function DateInput({ value, onValueChange, onBlur, ...props }: Props) {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setDraft(value)
  }
  return (
    <Input
      {...props}
      type="date"
      value={draft}
      onChange={e => {
        setDraft(e.target.value)
        if (!e.target.validity.badInput) onValueChange(e.target.value)
      }}
      onBlur={e => {
        if (e.target.validity.badInput) {
          e.target.value = value
          setDraft(value)
        }
        onBlur?.(e)
      }}
    />
  )
}
