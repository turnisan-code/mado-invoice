// Pure number helpers (no React, no path aliases) so the bank-statement modules can run under plain node.

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

// Same rule as utils/document.ts, repeated here because that module imports '@/types' and
// cannot be loaded by node for verification.
export const roundCents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
