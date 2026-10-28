// One colour per status for every list and the dashboard (documents and clients). No hooks, so
// server and client components can both render it.
export const STATUS_BADGE: Record<string, string> = {
  draft: 'text-neutral-500 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-400',
  sent: 'text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300',
  paid: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  overdue: 'text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300',
  accepted: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  rejected: 'text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300',
  expired: 'text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300',
  cancelled: 'text-neutral-500 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-400',
  active: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  inactive: 'text-neutral-500 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-400',
  lead: 'text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300',
}

export function StatusBadge({ status, label, className = '' }: { status: string; label: string; className?: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${STATUS_BADGE[status] ?? STATUS_BADGE.draft} ${className}`}>
      {label}
    </span>
  )
}
