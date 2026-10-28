import { FileX } from 'lucide-react'
import { documentT } from '@/lib/document-labels'
import type { Language } from '@/types'

// The document (and so its language) is unknown here, so the page says it in both languages.
export default function PortalNotFound() {
  const langs: Language[] = ['de', 'en']
  return (
    <main className="max-w-md mx-auto px-4 py-24 text-center space-y-8">
      <FileX size={28} className="mx-auto text-neutral-400" aria-hidden="true" />
      {langs.map(lang => {
        const t = documentT(lang)
        return (
          <section key={lang} lang={lang} className="space-y-2">
            <h1 className="text-lg font-semibold text-neutral-900">{t('pdfPortal.portal.notFoundTitle')}</h1>
            <p className="text-sm text-neutral-600">{t('pdfPortal.portal.notFoundBody')}</p>
          </section>
        )
      })}
    </main>
  )
}
