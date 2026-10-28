// Excel (de-AT) opens a BOM-prefixed, semicolon-separated file with decimal commas directly,
// without the import wizard; that is the format the owner and the Steuerberater receive.
export type CsvValue = string | number | null | undefined

export function csvNumber(n: number, decimals = 2): string {
  return n.toFixed(decimals).replace('.', ',')
}

export function csvDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-')
  return y && m && d ? `${d}.${m}.${y}` : iso
}

function cell(v: CsvValue): string {
  if (v == null) return ''
  if (typeof v === 'number') return csvNumber(v)
  return /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function toCsv(header: string[], rows: CsvValue[][]): string {
  return '﻿' + [header, ...rows].map(r => r.map(cell).join(';')).join('\r\n') + '\r\n'
}

export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
