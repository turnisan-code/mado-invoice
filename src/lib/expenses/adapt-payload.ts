// Ported from Bookmatic lib/bookamat.ts (475072f): the self-heal of a booking Bookamat
// refused with a 400, and the attachment name it keeps. Pure: Mado's client
// (lib/expenses/book.ts) retries with the corrected payload and reports every note.
import type { BookingPayload } from '@/lib/expenses/types'
import { normalizeCountry } from './vat-origin'

// The per-line part of a bookamat 400 body: it names a line by its position,
// e.g. {"amounts":[{},{"non_field_errors":["… blocked …"]}]}. null when the body
// has no per-line list (not JSON, or the error is about the booking itself).
function lineErrors(errText: string): string[] | null {
  try {
    const body = JSON.parse(errText)
    if (body && Array.isArray(body.amounts)) return body.amounts.map((e: unknown) => JSON.stringify(e ?? ''))
  } catch { /* not JSON */ }
  return null
}

// A corrected payload plus one German line per correction, for the result screen.
export type PayloadAdaptation = { payload: BookingPayload; notes: string[] }

// bookamat rejects some payloads with per-account validation rules that aren't
// exposed via its account API (deductibility "blocked" for a cost account, a
// date required by a purchasetax account, an invalid country). Given a 400 body,
// return a corrected payload for the known issues it names, or null if we can't
// self-heal. A 400 never persists a booking, so retrying after a correction is safe.
// Every correction is described in `notes`, so it is never silent.
export function adaptBookingPayload(p: BookingPayload, errText: string): PayloadAdaptation | null {
  const next: BookingPayload = JSON.parse(JSON.stringify(p))
  const notes: string[] = []

  // Invalid country → try to normalise; if that doesn't change it, drop the
  // country rather than fail the whole booking (it's a non-blocking field).
  if (/is not a valid choice/i.test(errText) && /country/i.test(errText)) {
    const fixed = normalizeCountry(next.country)
    if (fixed !== next.country) { notes.push(`Land „${next.country}“ → „${fixed}“`); next.country = fixed }
    else if (next.country) { notes.push(`Land „${next.country}“ von bookamat nicht akzeptiert — entfernt`); next.country = '' }
  }

  // Cost account "blocks" a deductibility value. Earlier attempts DELETED the
  // field and got "deductibility_…: This field is required" back — i.e. the
  // field is mandatory, and it's the VALUE (we send 100) that's rejected, not
  // its presence. The correct value in every observed case is 0:
  //   • Privatentnahme / Privateinlage / USt-Zahlung → BA Betrag % must be 0
  //     (private draws, equity, and tax payments aren't deductible expenses)
  //   • any 0%-USt line → BA USt % must be 0 (no Vorsteuer to apportion; this is
  //     the field bookamat blocks for e.g. Sozialversicherung, whose Betrag %
  //     legitimately stays 100)
  // So set the blocked field to 0 rather than removing it. bookamat reports the
  // two fields one at a time, so the retry loop fixes each in turn; if a field is
  // already 0 and still blocked we can't correct it blind and it surfaces.
  //
  // Only on the line bookamat names. Lines carry their own Steuerkonten, and the
  // block belongs to one account: zeroing every line turned e.g. a 500 € IG-Erwerb
  // line next to a locked fee line into BA USt 0 — Erwerbsteuer owed, no Vorsteuer.
  // When the error can't be tied to a line on a multi-line booking, don't guess.
  const perLine = lineErrors(errText)
  const zeroBlocked = (re: RegExp, field: 'deductibility_amount_percent' | 'deductibility_tax_percent', label: string) => {
    if (!re.test(errText)) return
    const lines = perLine
      ? perLine.map((e, k) => (re.test(e) ? k : -1)).filter(k => k >= 0)
      : next.amounts.length === 1 ? [0] : []
    for (const k of lines) {
      const a = next.amounts[k]
      if (!a || Number(a[field]) === 0) continue
      a[field] = '0.00'
      const where = next.amounts.length > 1 ? `Zeile ${k + 1}: ` : ''
      notes.push(`${where}${label} auf 0 % gesetzt — bookamat sperrt das Feld für dieses Steuerkonto`)
    }
  }
  zeroBlocked(/Deductibility amount percent is blocked/i, 'deductibility_amount_percent', 'BA Betrag')
  zeroBlocked(/Deductibility tax percent is blocked/i, 'deductibility_tax_percent', 'BA USt')

  // Purchasetax account requires a Rechnungs-/Lieferdatum (typical for IG-Erwerb /
  // reverse charge). Fall back to the booking (payment) date when we have no
  // extracted invoice date — a bookable proxy the user can correct, vs. failing.
  if (/Date invoice is required/i.test(errText) && !next.date_invoice) {
    next.date_invoice = next.date
    notes.push(`Rechnungsdatum fehlte — Zahlungsdatum ${next.date} eingesetzt, bitte prüfen`)
  }
  if (/Date delivery is required/i.test(errText) && !next.date_delivery) {
    next.date_delivery = next.date
    notes.push(`Lieferdatum fehlte — Zahlungsdatum ${next.date} eingesetzt, bitte prüfen`)
  }

  return notes.length ? { payload: next, notes } : null
}

// bookamat validates the attachment name's extension and rejects anything it can't
// cleanly parse — a name with internal dots ("…CD-Burn.DDP_2026-06-25.pdf", from a
// vendor/title containing a dot), backslashes, or odd characters yields
// {"name":["Invalid extension."]}. Rebuild a safe basename + one known extension,
// capped so truncation can never eat the extension. Defaults to .pdf (a genuine
// image keeps its extension).
export function safeAttachmentName(filename: string): string {
  const extMatch = filename.toLowerCase().match(/\.(pdf|jpe?g|png|gif)$/)
  const ext = extMatch ? extMatch[1].replace('jpeg', 'jpg') : 'pdf'
  const base = filename
    .replace(/\.[^.]*$/, '')       // drop the original extension
    .replace(/[^\w-]+/g, '_')      // word chars + hyphen only (kills dots, \, spaces)
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  return `${(base || 'beleg').slice(0, 40)}.${ext}`
}
