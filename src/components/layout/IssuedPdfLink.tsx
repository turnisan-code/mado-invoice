import { FileText } from 'lucide-react'

export default function IssuedPdfLink({ documentId }: { documentId: string }) {
  return (
    <a
      href={`/api/documents/${documentId}/pdf`}
      target="_blank"
      rel="noopener"
      title="The PDF stored when this document was issued"
      className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors shrink-0"
    >
      <FileText size={13} /> Issued PDF
    </a>
  )
}
