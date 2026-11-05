// The status menu issues a draft from outside the editor. When the issue dialog moves a stale
// draft to today, the editor on the same page writes the new dates itself, so its own state and
// its next autosave carry them instead of writing the old date back.
export const ISSUE_DATE_EVENT = 'document-builder:issue-date'

export type IssueDateDetail = {
  documentId: string
  date: string
  // Omitted: the due date stays as it is.
  dueDate?: string
  waitUntil: (pending: Promise<unknown>) => void
}

// True when an editor took the dates over (and wrote them); rejects when its write failed.
export async function applyIssueDateInEditor(documentId: string, date: string, dueDate?: string): Promise<boolean> {
  const pending: Promise<unknown>[] = []
  const detail: IssueDateDetail = { documentId, date, ...(dueDate === undefined ? {} : { dueDate }), waitUntil: p => { pending.push(p) } }
  window.dispatchEvent(new CustomEvent<IssueDateDetail>(ISSUE_DATE_EVENT, { detail }))
  await Promise.all(pending)
  return pending.length > 0
}
