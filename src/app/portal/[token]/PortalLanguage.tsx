'use client'

import { createContext, useContext, useEffect } from 'react'
import { documentT } from '@/lib/document-labels'
import type { DictKey } from '@/lib/i18n'
import type { Language } from '@/types'

const PortalLanguageContext = createContext<Language | null>(null)

export function PortalLanguageProvider({ lang, children }: { lang: Language | null; children: React.ReactNode }) {
  return <PortalLanguageContext.Provider value={lang}>{children}</PortalLanguageContext.Provider>
}

const BOTH: Language[] = ['de', 'en']

// A full-page notice for the client: in the document's language when it is known, else in German
// and English. It never links into the app, which the client cannot open.
export function PortalNotice({ icon, title, body, retry }: { icon: React.ReactNode; title: DictKey; body: DictKey; retry?: () => void }) {
  const known = useContext(PortalLanguageContext)
  const langs = known ? [known] : BOTH

  useEffect(() => {
    if (known) document.documentElement.lang = known
  }, [known])

  return (
    <main className="max-w-md mx-auto px-4 py-24 text-center space-y-8">
      {icon}
      {langs.map(lang => {
        const t = documentT(lang)
        return (
          <section key={lang} lang={lang} className="space-y-2">
            <h1 className="text-lg font-semibold text-neutral-900">{t(title)}</h1>
            <p className="text-sm text-neutral-600">{t(body)}</p>
          </section>
        )
      })}
      {retry && (
        <button
          type="button"
          onClick={retry}
          className="inline-flex items-center justify-center min-h-11 px-4 rounded-lg bg-neutral-900 text-white text-sm font-medium hover:bg-neutral-700 transition-colors"
        >
          {langs.map(lang => documentT(lang)('messages.portal.retry')).join(' / ')}
        </button>
      )}
    </main>
  )
}
