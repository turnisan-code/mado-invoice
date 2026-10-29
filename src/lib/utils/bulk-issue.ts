// Issuing several drafts at once (the lists' "Mark sent" / "Mark paid"): the rules the server
// applies and the confirm dialog announces. Pure, so both sides and node checks share it.

export type LatestIssued = { number: string; date: string }

// What issuing one draft of the batch reported back, beyond its number.
export interface IssuedNote {
  id: string
  number: string
  // The draft's own date when it was issued with today's instead.
  movedFrom: string | null
  // Its date could not move to today: another invoice of its recurring schedule already has it.
  dateKept: boolean
  // Still dated before the newest issued document of its type: the numbers no longer follow the dates.
  beforeLatest: LatestIssued | null
  snapshotFailed: boolean
  driveError: { error: string; code?: string } | null
  // Time entries and expenses billed on it that no longer sit on one of its lines.
  unlinked: { time: number; expenses: number } | null
}

// Oldest first (then in the order they were created), so the numbers follow the dates.
export function issueOrder<T extends { date: string | null; created_at?: string | null }>(drafts: readonly T[]): T[] {
  return [...drafts].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || (a.created_at ?? '').localeCompare(b.created_at ?? ''))
}

// Like the issue dialog's default: a draft dated before today is issued with today's date. No
// issued document is dated after tomorrow (MI001), so today is never before one by more than that.
export function movesToToday(date: string | null, today: string): boolean {
  return !!date && date < today
}

// Dated before the newest issued document: issuing it breaks the chronological order of the numbers.
export function beforeLatest(date: string | null, latest: LatestIssued | null): boolean {
  return !!date && !!latest && date < latest.date
}

// The newest issued document among those given (the list's rows).
export function latestIssued(docs: readonly { number: string | null; date: string | null }[]): LatestIssued | null {
  let latest: LatestIssued | null = null
  for (const d of docs) {
    if (d.number && d.date && (!latest || d.date > latest.date)) latest = { number: d.number, date: d.date }
  }
  return latest
}

export function hasIssueProblem(n: IssuedNote): boolean {
  return n.dateKept || !!n.beforeLatest || n.snapshotFailed || !!n.driveError || !!n.unlinked
}

export function isIssuedNoteList(value: unknown): value is IssuedNote[] {
  return Array.isArray(value) && value.every(v => v && typeof v === 'object' && typeof (v as IssuedNote).id === 'string' && typeof (v as IssuedNote).number === 'string')
}
