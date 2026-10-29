import { FileX } from 'lucide-react'
import { PortalNotice } from './PortalLanguage'

// In the document's language when the token belongs to a document, else in German and English.
export default function PortalNotFound() {
  return (
    <PortalNotice
      icon={<FileX size={28} className="mx-auto text-neutral-400" aria-hidden="true" />}
      title="pdfPortal.portal.notFoundTitle"
      body="pdfPortal.portal.notFoundBody"
    />
  )
}
