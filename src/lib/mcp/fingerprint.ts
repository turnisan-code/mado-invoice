// What an irreversible action depends on, as one hash: canonical JSON (object keys sorted at
// every level, array order kept, undefined members left out as JSON.stringify does), then SHA-256.
// The same state gives the same fingerprint whatever order a query returned its columns in.
import { sha256Hex } from './crypto'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(v => (v === undefined || typeof v === 'function' ? null : canonical(v)))
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined && typeof v !== 'function') out[key] = canonical(v)
    }
    return out
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? 'null'
}

export function fingerprintOf(state: unknown): string {
  return sha256Hex(canonicalJson(state))
}

// Database numerics may come back as strings or numbers depending on the column; the fingerprint
// compares them as numbers rounded to the cent.
export function cents(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}
