// The owner's own UID. It is printed on every invoice he receives („Ihre UID“,
// „Rechnung an“), so the AI keeps reading it as the supplier's or client's UID:
// it was stored on three bookings, and a bare „ATU“ on
// another. A counterparty never has this UID.
//
// Mado: the UID of Einstellungen („UID-Nummer“), set with the owner's name and accounts by
// lib/expenses/owner.ts setExpenseOwner before the engine runs (the server per request, the
// page with its settings). Bookmatic read it from an env variable. '' = none set: then no
// value is the owner's.
export let OWN_VATIN = ''

const normalise = (v: string) => v.replace(/[\s.\-]/g, '').toUpperCase()

export function setOwnVatin(raw: string | null | undefined): void {
  OWN_VATIN = normalise(raw || '')
}

// The owner's own UID, however it is written (spaces, dots, hyphens, case)
export const isOwnVatin = (raw: string | null | undefined): boolean => !!OWN_VATIN && normalise(raw || '') === OWN_VATIN

// The counterparty's UID as it may be booked, or '' when the value is the owner's
// own UID or only a country prefix without a number („ATU“, „DE“).
export function counterpartyVatin(raw: string | null | undefined): string {
  const v = normalise(raw || '')
  if (!v) return ''
  if (isOwnVatin(raw)) return ''
  if (!/\d/.test(v)) return ''
  return (raw || '').trim()
}
