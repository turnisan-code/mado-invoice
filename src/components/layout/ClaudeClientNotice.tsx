import Link from 'next/link'
import type { TFn } from '@/lib/i18n'

const TEXT = {
  invoice: 'clients.changedByClaudeOn.invoice',
  credit_note: 'clients.changedByClaudeOn.credit_note',
  quote: 'clients.changedByClaudeOn.quote',
} as const

// An issued document whose client a Claude session created or changed and the owner has not saved
// in Mado since (clients.mcp_written_at, 20261105_mcp_drafts.sql): its automatic reminders and
// Bookamat sync, a new archive copy and the share link's recipient block wait until the client is
// saved. Said here, where those flows are, with the way to the client page that clears it.
export default function ClaudeClientNotice({ clientId, kind, t }: { clientId: string; kind: keyof typeof TEXT; t: TFn }) {
  return (
    <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300">
      {t(TEXT[kind])}{' '}
      <Link href={`/clients/${clientId}`} className="font-medium underline underline-offset-2 hover:text-amber-950 dark:hover:text-amber-100">
        {t('clients.changedByClaudeOn.open')}
      </Link>
    </p>
  )
}
