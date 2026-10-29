'use client'

import { Download, Eye, HardDrive, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n/client'

interface Props {
  saving: boolean
  gmailConnected: boolean
  saveStatus: { text: string; cls: string } | null
  // A new document can be saved as a draft; a draft can be issued.
  canSaveDraft: boolean
  canIssue: boolean
  onPreview: () => void
  onDownload: () => void
  onDrive: () => void
  onEmail: () => void
  onSaveDraft: () => void
  onIssue: () => void
}

// One tool button for both layouts: an icon over a short label in the segmented phone toolbar,
// an outlined button with the full label from the sm breakpoint.
function Tool({ icon, short, long, onClick, disabled, ghost }: {
  icon: React.ReactNode
  short: string
  long: string
  onClick: () => void
  disabled?: boolean
  ghost?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 flex flex-col items-center gap-1 py-2.5 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 active:bg-neutral-100 dark:active:bg-neutral-700 transition-colors disabled:opacity-50
        sm:flex-none sm:flex-row sm:gap-1.5 sm:h-7 sm:py-0 sm:px-2.5 sm:rounded-lg sm:text-[0.8rem] sm:font-medium sm:active:bg-transparent ${ghost
          ? 'sm:hover:bg-muted'
          : 'sm:border sm:border-border sm:bg-background sm:text-foreground sm:hover:bg-muted dark:sm:border-input dark:sm:bg-input/30 dark:sm:hover:bg-input/50'}`}
    >
      {icon}
      <span className="text-[11px] font-medium sm:hidden">{short}</span>
      <span className="hidden sm:inline">{long}</span>
    </button>
  )
}

// The editor's sticky action bar; on phones it sits above the fixed bottom tab bar.
export function ActionBar({ saving, gmailConnected, saveStatus, canSaveDraft, canIssue, onPreview, onDownload, onDrive, onEmail, onSaveDraft, onIssue }: Props) {
  const { t } = useT()
  const status = saveStatus && (
    <p aria-live="polite" className={`order-last sm:order-none text-[11px] sm:text-xs text-center -mt-1 sm:mt-0 sm:mr-1 ${saveStatus.cls || 'text-neutral-500 dark:text-neutral-400'}`}>
      {saveStatus.text}
    </p>
  )
  return (
    <div className="sticky bottom-[calc(3.5rem_+_env(safe-area-inset-bottom))] md:bottom-0 -mx-4 -mb-4 sm:-mx-6 sm:-mb-6 bg-white/95 dark:bg-neutral-900/95 backdrop-blur border-t border-neutral-200 dark:border-neutral-700">
      <div className="flex flex-col gap-3 px-4 pt-3 pb-4 sm:flex-row sm:items-center sm:px-6 sm:py-4">
        <div className="flex rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden divide-x divide-neutral-200 dark:divide-neutral-700
          sm:items-center sm:gap-3 sm:rounded-none sm:border-0 sm:overflow-visible sm:divide-x-0">
          <Tool ghost icon={<Eye size={16} className="sm:size-[13px]" />} short={t('builder.preview')} long={t('builder.preview')} onClick={onPreview} />
          <div className="hidden sm:block w-px h-5 bg-neutral-200 dark:bg-neutral-700" />
          <Tool icon={<Download size={16} className="sm:size-[13px]" />} short={t('builder.pdf')} long={t('builder.downloadPdf')} onClick={onDownload} disabled={saving} />
          {gmailConnected && (
            <Tool icon={<HardDrive size={16} className="sm:size-[13px]" />} short={t('builder.drive')} long={t('builder.saveToDrive')} onClick={onDrive} disabled={saving} />
          )}
          <Tool
            icon={<Mail size={16} className="sm:size-[13px]" />}
            short={gmailConnected ? t('builder.gmail') : t('builder.email')}
            long={gmailConnected ? t('builder.sendViaGmail') : t('builder.sendViaSuperhuman')}
            onClick={onEmail}
            disabled={saving}
          />
        </div>
        <div className="hidden sm:block flex-1" />
        {status}
        {(canSaveDraft || canIssue) && (
          <div className="flex gap-2">
            {canSaveDraft && (
              <Button type="button" variant="outline" onClick={onSaveDraft} disabled={saving} className="flex-1 h-11 text-sm sm:flex-none sm:h-7 sm:text-[0.8rem] sm:border-transparent sm:bg-transparent sm:hover:bg-muted">
                {t('builder.saveDraft')}
              </Button>
            )}
            {canIssue && (
              <Button type="button" onClick={onIssue} disabled={saving} className="flex-1 h-11 text-sm sm:flex-none sm:h-7 sm:text-[0.8rem]">
                {saving ? t('common.saving') : t('builder.markAsSent')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
