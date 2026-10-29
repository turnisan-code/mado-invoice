'use client'

import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { today } from '@/lib/utils/document'
import { useT } from '@/lib/i18n/client'
import { checkboxClass, inputClass, labelClass } from './ui'

// Picks the period of a client's statement and opens the PDF in a new tab. Mount only while open.
export default function StatementDialog({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const { t } = useT()
  const id = useId()
  const [to, setTo] = useState(() => today())
  const [from, setFrom] = useState(() => `${today().slice(0, 4)}-01-01`)
  const [openOnly, setOpenOnly] = useState(false)

  // Open items are listed up to the end date, whenever they were issued.
  function open() {
    if (!to || (!openOnly && (!from || from > to))) { toast.error(t('projects.statement.rangeInvalid')); return }
    const query = new URLSearchParams(openOnly ? { to, open: '1' } : { from, to })
    window.open(`/api/clients/${clientId}/statement?${query}`, '_blank', 'noopener')
    onClose()
  }

  return (
    <Dialog open onClose={onClose} title={t('projects.statement.title')} description={t('projects.statement.desc')} panelClassName="max-w-md">
      <form onSubmit={e => { e.preventDefault(); open() }} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-from`} className={labelClass}>{t('projects.statement.from')}</label>
            <input id={`${id}-from`} type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} disabled={openOnly} className={inputClass} />
          </div>
          <div>
            <label htmlFor={`${id}-to`} className={labelClass}>{t('projects.statement.to')}</label>
            <input id={`${id}-to`} type="date" value={to} min={openOnly ? undefined : from || undefined} onChange={e => setTo(e.target.value)} className={inputClass} />
          </div>
        </div>
        <label className="flex items-center gap-2.5 text-sm text-neutral-700 dark:text-neutral-300 cursor-pointer select-none">
          <input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} className={checkboxClass} />
          {t('projects.statement.openOnly')}
        </label>
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit">{t('projects.statement.download')}</Button>
        </div>
      </form>
    </Dialog>
  )
}
