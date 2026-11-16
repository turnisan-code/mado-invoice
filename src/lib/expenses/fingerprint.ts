// What a line's preview showed, as one short hash of the fields Bookamat receives (PR 9a). The
// page sends it with each line it books; the server books a line only when the payload it builds
// itself has the same — so a change the server never received (a save that failed or overtook
// another), or accounts read differently, books nothing instead of something else.
//
// Pure and client-safe: the page and the server compute it the same way.
import type { BookingPayload } from './types'

export function payloadFingerprint(p: BookingPayload): string {
  const fields = {
    t: p.title, d: p.date, di: p.date_invoice ?? null, dd: p.date_delivery ?? null, v: p.vatin, c: p.country, de: p.description,
    a: p.amounts.map(a => [
      a.bankaccount, a.costaccount, a.purchasetaxaccount ?? null, a.amount, a.tax_percent,
      a.deductibility_tax_percent ?? null, a.deductibility_amount_percent ?? null, a.country_dep, a.country_rec,
    ]),
  }
  // FNV-1a over the JSON's UTF-16 code units: the same in every runtime
  const s = JSON.stringify(fields)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
