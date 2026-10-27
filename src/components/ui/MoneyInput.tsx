'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { formatLocaleNumber, parseLocaleNumber } from '@/lib/utils/number'

export { parseLocaleNumber, formatLocaleNumber }

export interface MoneyInputProps extends Omit<React.ComponentProps<'input'>, 'value' | 'onChange' | 'type' | 'inputMode'> {
  value: number | null
  onValueChange: (value: number | null) => void
  /** Whole numbers only: numeric keypad, no decimals. */
  integer?: boolean
  /** Maximum fraction digits when formatting back (default 2). */
  decimals?: number
}

// Text input that keeps what the user types while focused, reports a parsed number on every
// valid keystroke and formats the committed value back on blur.
export function MoneyInput({ value, onValueChange, integer = false, decimals = 2, onFocus, onBlur, ...props }: MoneyInputProps) {
  const fractionDigits = integer ? 0 : decimals
  const [text, setText] = useState(() => formatLocaleNumber(value, fractionDigits))
  const [focused, setFocused] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [seenValue, setSeenValue] = useState(value)

  // Follow outside changes (catalogue pick, reset) while the field is not being edited.
  if (value !== seenValue) {
    setSeenValue(value)
    if (!focused) setText(formatLocaleNumber(value, fractionDigits))
  }

  function commit(raw: string) {
    setText(raw)
    if (raw.trim() === '') { setInvalid(false); onValueChange(null); return }
    const parsed = parseLocaleNumber(raw)
    if (parsed === null) { setInvalid(true); return }
    setInvalid(false)
    onValueChange(integer ? Math.round(parsed) : parsed)
  }

  return (
    <Input
      {...props}
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      autoComplete="off"
      value={text}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
      onChange={e => commit(e.target.value)}
      onFocus={e => { setFocused(true); onFocus?.(e) }}
      onBlur={e => {
        setFocused(false)
        setInvalid(false)
        setText(formatLocaleNumber(value, fractionDigits))
        onBlur?.(e)
      }}
    />
  )
}

export default MoneyInput
