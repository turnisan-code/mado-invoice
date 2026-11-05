import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import { isWorded, word } from '@/lib/mcp/actions/words'
import { actionState } from '@/lib/mcp/confirm'
import type { McpAction } from '@/types'
import { StateBadge } from './ActionView'

type Row = Pick<McpAction, 'id' | 'kind' | 'label' | 'preview' | 'approval' | 'status' | 'created_at' | 'expires_at' | 'claimed_at'> & {
  mcp_grants: { client_name: string } | null
}

const RECENT = 20

const when = (iso: string, lang: string) => new Date(iso).toLocaleString(lang === 'de' ? 'de-AT' : 'en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Vienna' })

// Everything Claude prepared lately: what still waits for the owner first, then what came of the rest.
export default async function ApprovalsPage() {
  const supabase = await createClient()
  const { t, lang } = await getT()
  const { data } = await supabase.from('mcp_actions')
    .select('id, kind, label, preview, approval, status, created_at, expires_at, claimed_at, mcp_grants(client_name)')
    .order('created_at', { ascending: false })
    .limit(100)
  const rows = (data ?? []) as unknown as Row[]
  const pending = rows.filter(r => actionState(r) === 'pending')
  const recent = rows.filter(r => actionState(r) !== 'pending').slice(0, RECENT)

  const item = (r: Row) => {
    const state = actionState(r)
    const stored = (r.preview ?? {}) as Record<string, unknown>
    const summary = isWorded(stored.summary) ? word(t, lang, stored.summary) : r.label
    return (
      <li key={r.id}>
        <Link href={`/mcp/approve/${r.id}`} className="block px-4 sm:px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">{t(`mcp.approve.kinds.${r.kind}`)}</span>
            <StateBadge state={state} t={t} />
          </div>
          <p className="text-sm mt-1 break-words">{summary}</p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            {r.mcp_grants?.client_name ? `${r.mcp_grants.client_name} · ` : ''}
            {state === 'pending' ? t('mcp.approve.expiresAt', { time: when(r.expires_at, lang) }) : t('mcp.approve.preparedAt', { time: when(r.created_at, lang) })}
          </p>
        </Link>
      </li>
    )
  }

  const listCls = 'rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 divide-y divide-neutral-100 dark:divide-neutral-800 overflow-hidden'
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('mcp.approve.listTitle')}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{t('mcp.approve.listSubtitle')}</p>
      </div>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('mcp.approve.pendingHeading')}</h2>
        {pending.length
          ? <ul className={listCls}>{pending.map(item)}</ul>
          : <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('mcp.approve.none')}</p>}
      </section>
      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">{t('mcp.approve.recentHeading')}</h2>
          <ul className={listCls}>{recent.map(item)}</ul>
        </section>
      )}
    </div>
  )
}
