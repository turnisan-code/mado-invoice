/**
 * Turn a bookamat validation failure into something actionable.
 *
 * bookamat reports these as raw English JSON, which reached the results list verbatim:
 *   bookamat API error 400: {"non_field_errors":["Vatin is required because of the
 *   selected purchasetax account."]}
 * That states what was refused, not what to do about it.
 *
 * Lives in its own module (no imports) because lib/bookamat.ts pulls in supabaseAdmin,
 * and this is needed by the import page, which is a client component.
 */

const HINTS: { match: RegExp; hint: string }[] = [
  { match: /Vatin is required/i,
    hint: 'UID-Nummer des Lieferanten fehlt — bei innergemeinschaftlichem Erwerb verlangt bookamat sie. UID in der Buchung ergänzen und erneut versuchen.' },
  { match: /Deductibility (amount|tax) percent is blocked/i,
    hint: 'Das gewählte Steuerkonto gibt die Abzugsfähigkeit selbst vor und akzeptiert den gesendeten Wert nicht. Meist korrigiert sich das automatisch — bleibt es bestehen, die BA-Prozentsätze in bookamat prüfen.' },
  { match: /tax percent value is not allowed/i,
    hint: 'Der USt-Satz passt nicht zum gewählten Vorsteuerkonto. Entweder den Satz ändern oder ein anderes Vorsteuerkonto wählen.' },
  { match: /purchasetax account is not allowed to be used with the given cost account/i,
    hint: 'Diese Kombination aus Steuerkonto und Vorsteuerkonto erlaubt bookamat nicht. Ein Vorsteuerkonto wählen, das zum Steuerkonto gehört (z. B. Lizenzgebühren → IG Erwerb von Leistungen).' },
  { match: /purchasetaxaccount.{0,40}required/i,
    hint: 'Es fehlt ein Vorsteuerkonto. Bei 0 % USt ist das meist „Keine Vorsteuer".' },
  { match: /Date invoice is required/i,
    hint: 'Das gewählte Vorsteuerkonto verlangt ein Rechnungsdatum.' },
  { match: /Date delivery is required/i,
    hint: 'Das gewählte Vorsteuerkonto verlangt ein Lieferdatum.' },
  { match: /Invalid extension/i,
    hint: 'Der Dateiname des Belegs wurde abgelehnt. Die Buchung selbst wurde angelegt — nur der Beleg fehlt.' },
  { match: /is not a valid choice/i,
    hint: 'Ein Feldwert ist für bookamat ungültig — meist das Länderkürzel (ISO-Code wie DE, US, GB verwenden).' },
]

export function humanizeBookamatError(raw: string): string {
  const hit = HINTS.find(h => h.match.test(raw))
  // Unrecognised errors pass through untouched — a confusing message beats a hidden
  // one. Recognised ones keep the original attached: it's the ground truth if the
  // hint is ever wrong.
  return hit ? `${hit.hint}\n${raw}` : raw
}
