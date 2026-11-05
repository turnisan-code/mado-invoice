import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import { makeT } from '@/lib/i18n'
import { isUuid } from '@/lib/auth'
import { actionKind } from '@/lib/mcp/actions'
import { ownerHold, type OwnerHold } from '@/lib/mcp/actions/common'
import { isWorded, word } from '@/lib/mcp/actions/words'
import { actionState, readAction } from '@/lib/mcp/confirm'
import type { ServiceContext } from '@/lib/mcp/types'
import type { Settings } from '@/types'
import { ActionPreview, ActionResult, Notices, StateBadge, wordedList } from '../ActionView'
import ApproveForm from './ApproveForm'

// An approved action runs in this page's Server Action: issuing renders and archives PDFs, a
// Bookamat sync posts per year. No Claude timer applies here.
export const maxDuration = 300

const when = (iso: string, lang: string) => new Date(iso).toLocaleString(lang === 'de' ? 'de-AT' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Vienna' })

export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const supabase = await createClient()
  const { t, lang } = await getT()
  const row = await readAction(supabase, id)
  if (!row) notFound()

  const [{ data: grant }, { data: settingsRow }] = await Promise.all([
    supabase.from('mcp_grants').select('client_name, client_kind, revoked_at').eq('id', row.grant_id).maybeSingle(),
    supabase.from('settings').select('*').single(),
  ])
  const settings = settingsRow as Settings | null
  const state = actionState(row)

  // The state is compared again now, so a document edited since Claude prepared this is caught
  // before the owner types a code. A refusal only the owner lifts in Mado (a client Claude wrote,
  // payments Claude changed) is shown as it is, with the page where: preparing again would not help.
  let changed = false
  let hold: OwnerHold | null = null
  if (state === 'pending') {
    const ctx: ServiceContext = {
      supabase,
      settings: async () => {
        if (!settings) throw new Error('Settings not found')
        return settings
      },
      t: makeT('en'),
      deadline: null,
    }
    try {
      const def = actionKind(row.kind)
      changed = !def || await def.fingerprint(ctx, def.argsSchema.parse(row.args)) !== row.fingerprint
    } catch (err) {
      changed = true
      hold = ownerHold(err)
    }
  }

  const preview = (row.preview ?? {}) as Record<string, unknown>
  const heading = isWorded(preview.summary) ? word(t, lang, preview.summary) : row.label
  const revoked = !!grant?.revoked_at

  return (
    <div className="space-y-5">
      <Link href="/mcp/approve" className="text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100">
        ← {t('mcp.approve.allApprovals')}
      </Link>
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">{t(`mcp.approve.kinds.${row.kind}`)}</span>
          <StateBadge state={state} t={t} />
        </div>
        <h1 className="text-xl font-semibold break-words">{heading}</h1>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {grant?.client_name ? `${t('mcp.approve.preparedBy', { client: grant.client_name })} · ` : ''}
          {t('mcp.approve.preparedAt', { time: when(row.created_at, lang) })}
          {state === 'pending' ? ` · ${t('mcp.approve.expiresAt', { time: when(row.expires_at, lang) })}` : ''}
        </p>
        {lang !== 'en' && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400 break-words">{t('mcp.approve.labelInClaude')}: {row.label}</p>
        )}
      </div>

      <ActionResult row={row} state={state} t={t} lang={lang} />

      <Notices items={wordedList(t, lang, preview.notices)} t={t} />
      <ActionPreview row={row} t={t} lang={lang} />

      {state === 'pending' && (
        changed
          ? (
            <p role="alert" className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-800 dark:text-red-300">
              {hold ? word(t, lang, hold.worded) : t('mcp.approve.changed')}
              {hold?.link && (
                <>
                  {' '}
                  <a href={hold.link.href} className="font-medium underline underline-offset-2">
                    {t(hold.link.target === 'client' ? 'mcp.approve.openClient' : 'mcp.approve.openDocument')}
                  </a>
                </>
              )}
            </p>
          )
          : (
            <>
              {revoked && <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('mcp.approve.revoked')}</p>}
              {row.approval === 'chat' && !revoked && <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('mcp.approve.chatChannel')}</p>}
            </>
          )
      )}
      {state === 'pending' && <ApproveForm id={row.id} requireCode={settings?.mcp_approval_totp !== false} canApprove={!changed && !revoked} />}
      {state === 'running' && <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('mcp.approve.runningInfo')}</p>}
      {state === 'unknown' && <p className="text-sm text-amber-700 dark:text-amber-400">{t('mcp.approve.unknownInfo')}</p>}
      {state === 'rejected' && <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('mcp.approve.rejectedInfo')}</p>}
      {state === 'expired' && <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('mcp.approve.expiredInfo')}</p>}
    </div>
  )
}
