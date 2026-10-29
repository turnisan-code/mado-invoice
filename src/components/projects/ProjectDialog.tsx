'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { clientLabel, type NamedClient } from '@/lib/utils/clients'
import { PROJECT_STATUSES } from '@/lib/projects'
import { useT } from '@/lib/i18n/client'
import type { DictKey } from '@/lib/i18n'
import type { Project, ProjectStatus } from '@/types'
import { inputClass, labelClass, textareaClass } from './ui'

export type ClientOption = NamedClient & { id: string }

type Values = {
  client_id: string
  name: string
  status: ProjectStatus
  hourly_rate: number | null
  budget_hours: number | null
  budget_amount: number | null
  notes: string
}

function initialValues(project: Project | undefined, defaultClientId: string | undefined): Values {
  return {
    client_id: project?.client_id ?? defaultClientId ?? '',
    name: project?.name ?? '',
    status: project?.status ?? 'active',
    hourly_rate: project?.hourly_rate ?? null,
    budget_hours: project?.budget_hours ?? null,
    budget_amount: project?.budget_amount ?? null,
    notes: project?.notes ?? '',
  }
}

function validate(v: Values): DictKey | null {
  if (!v.client_id) return 'projects.form.clientRequired'
  if (!v.name.trim()) return 'projects.form.nameRequired'
  if ([v.hourly_rate, v.budget_hours, v.budget_amount].some(n => n !== null && n < 0)) return 'projects.form.negative'
  return null
}

// Creates a project (and opens it) or edits one. Mount it only while open, so it starts from the
// project as it is now.
export default function ProjectDialog({ project, clients, defaultClientId, lockClient = false, onClose }: {
  project?: Project
  clients: ClientOption[]
  defaultClientId?: string
  // Billed entries keep the project with its client.
  lockClient?: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const supabase = createClient()
  const { t } = useT()
  const id = useId()
  const [values, setValues] = useState(() => initialValues(project, defaultClientId))
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<Values>) => setValues(v => ({ ...v, ...patch }))

  async function save() {
    const invalid = validate(values)
    if (invalid) { toast.error(t(invalid)); return }
    setSaving(true)
    const row = {
      client_id: values.client_id,
      name: values.name.trim(),
      status: values.status,
      hourly_rate: values.hourly_rate,
      // A zero budget means none (the columns only take positive budgets).
      budget_hours: values.budget_hours || null,
      budget_amount: values.budget_amount || null,
      notes: values.notes.trim() || null,
    }
    if (project) {
      const { error } = await supabase.from('projects').update(row).eq('id', project.id)
      setSaving(false)
      if (error) { toast.error(t('projects.form.saveFailed')); return }
      toast.success(t('projects.form.saved'))
      onClose()
      router.refresh()
      return
    }
    const { data, error } = await supabase.from('projects').insert(row).select('id').single()
    if (error || !data) { setSaving(false); toast.error(t('projects.form.saveFailed')); return }
    toast.success(t('projects.form.created'))
    router.push(`/projects/${data.id}`)
  }

  const optional = <span className="font-normal text-neutral-400 dark:text-neutral-500">({t('projects.form.optional')})</span>

  return (
    <Dialog open onClose={onClose} title={project ? t('projects.form.editTitle') : t('projects.form.createTitle')} busy={saving} panelClassName="max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <form onSubmit={e => { e.preventDefault(); void save() }} className="space-y-4">
        <div className="space-y-3">
          <div>
            <label htmlFor={`${id}-client`} className={labelClass}>{t('projects.form.client')}</label>
            <select id={`${id}-client`} value={values.client_id} onChange={e => set({ client_id: e.target.value })} disabled={saving || lockClient} className={inputClass}>
              <option value="">{t('projects.form.selectClient')}</option>
              {clients.map(c => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-name`} className={labelClass}>{t('projects.form.name')}</label>
            <input id={`${id}-name`} type="text" value={values.name} onChange={e => set({ name: e.target.value })} placeholder={t('projects.form.namePlaceholder')} maxLength={160} disabled={saving} className={inputClass} />
          </div>
          {project && (
            <div>
              <label htmlFor={`${id}-status`} className={labelClass}>{t('projects.form.status')}</label>
              <select id={`${id}-status`} value={values.status} onChange={e => set({ status: e.target.value as ProjectStatus })} disabled={saving} className={inputClass}>
                {PROJECT_STATUSES.map(s => <option key={s} value={s}>{t(`projects.statuses.${s}`)}</option>)}
              </select>
            </div>
          )}
          <div>
            <label htmlFor={`${id}-rate`} className={labelClass}>{t('projects.form.hourlyRate')} {optional}</label>
            <MoneyInput id={`${id}-rate`} value={values.hourly_rate} onValueChange={v => set({ hourly_rate: v })} disabled={saving} className={inputClass} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-bh`} className={labelClass}>{t('projects.form.budgetHours')} {optional}</label>
              <MoneyInput id={`${id}-bh`} value={values.budget_hours} onValueChange={v => set({ budget_hours: v })} disabled={saving} className={inputClass} />
            </div>
            <div>
              <label htmlFor={`${id}-ba`} className={labelClass}>{t('projects.form.budgetAmount')} {optional}</label>
              <MoneyInput id={`${id}-ba`} value={values.budget_amount} onValueChange={v => set({ budget_amount: v })} disabled={saving} className={inputClass} />
            </div>
          </div>
          <div>
            <label htmlFor={`${id}-notes`} className={labelClass}>{t('projects.form.notes')} {optional}</label>
            <textarea id={`${id}-notes`} value={values.notes} onChange={e => set({ notes: e.target.value })} rows={3} disabled={saving} className={textareaClass} />
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={saving}>{saving ? t('common.saving') : project ? t('common.save') : t('common.create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}
