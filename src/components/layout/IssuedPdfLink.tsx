import { FileText, HardDrive } from 'lucide-react'
import { getT } from '@/lib/i18n/server'

const linkCls = 'flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors shrink-0'

// Where the issued copy lives: the stored PDF and, once archived there, the Google Drive file.
export default async function IssuedPdfLink({ documentId, driveFileId }: { documentId: string; driveFileId?: string | null }) {
  const { t } = await getT()
  return (
    <>
      <a href={`/api/documents/${documentId}/pdf`} target="_blank" rel="noopener" title={t('documents.issuedPdfTitle')} className={linkCls}>
        <FileText size={13} /> {t('documents.issuedPdf')}
      </a>
      {driveFileId && (
        <a
          href={`https://drive.google.com/file/d/${encodeURIComponent(driveFileId)}/view`}
          target="_blank"
          rel="noopener"
          title={t('archive.inDriveTitle')}
          aria-label={t('archive.inDriveTitle')}
          className={linkCls}
        >
          <HardDrive size={13} /> <span className="hidden sm:inline">{t('archive.inDrive')}</span>
        </a>
      )}
    </>
  )
}
