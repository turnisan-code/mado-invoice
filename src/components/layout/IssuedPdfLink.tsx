import { FileText } from 'lucide-react'
import { getT } from '@/lib/i18n/server'

export default async function IssuedPdfLink({ documentId }: { documentId: string }) {
  const { t } = await getT()
  return (
    <a
      href={`/api/documents/${documentId}/pdf`}
      target="_blank"
      rel="noopener"
      title={t('documents.issuedPdfTitle')}
      className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors shrink-0"
    >
      <FileText size={13} /> {t('documents.issuedPdf')}
    </a>
  )
}
