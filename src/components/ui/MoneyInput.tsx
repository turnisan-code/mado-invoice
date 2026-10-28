'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'

// Accepts Austrian and English notation: "1.234,56", "12,5", "12.5", "1,234.56".
// With both separators present the last one is the decimal separator; a separator that
// occurs more than once on its own is a thousands separator.
export function parseLocaleNumber(raw: string): number | null {
  const s = raw.replace(/[\s€$£%]/g, '')
  if (!s) return null
  const commas = (s.match(/,/g) ?? []).length
  const dots = (s.match(/\./g) ?? []).length
  let normalized: string
  if (commas && dots) {
    const commaIsDecimal = s.lastIndexOf(',') > s.lastIndexOf('.')
    const decimalCount = commaIsDecimal ? commas : dots
    if (decimalCount > 1) return null
    normalized = commaIsDecimal ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (commas) {
    normalized = commas === 1 ? s.replace(',', '.') : s.replace(/,/g, '')
  } else {
    // A lone dot followed by exactly three digits is the Austrian thousands dot ("1.500" = 1500);
    // a comma stays the decimal separator ("1,500" = 1.5).
    const thousandsDot = dots === 1 && /^-?\d+\.\d{3}$/.test(s)
    normalized = dots === 1 && !thousandsDot ? s : s.replace(/\./g, '')
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(normalized)) return null
  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

export function formatLocaleNumber(n: number | null, decimals: number): string {
  if (n === null || Number.isNaN(n)) return ''
  return new Intl.NumberFormat('de-AT', { minimumFractionDigits: 0, maximumFractionDigits: decimals, useGrouping: false }).format(n)
}

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
