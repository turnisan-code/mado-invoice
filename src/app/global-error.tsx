'use client'

import { useState } from 'react'
import './globals.css'
import { isUiLang, makeT, type UiLang } from '@/lib/i18n'

// This replaces the root layout, so the LanguageProvider is gone; the <html lang> the
// layout rendered is still in the DOM on the first render and carries the saved language.
function initialLang(): UiLang {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : ''
  return isUiLang(lang) ? lang : 'en'
}

export default function GlobalError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  const [lang] = useState(initialLang)
  const t = makeT(lang)
  return (
    <html lang={lang}>
      <body className="min-h-screen flex items-center justify-center p-6 bg-neutral-50 text-neutral-900 antialiased">
        <main className="w-full max-w-sm text-center space-y-4">
          <h1 className="text-xl font-semibold">{t('errors.somethingWrong')}</h1>
          <p className="text-sm text-neutral-500">
            {t('errors.appNotLoaded')}
          </p>
          {error.digest && <p className="text-xs text-neutral-500">{t('errors.reference', { digest: error.digest })}</p>}
          <div className="flex justify-center gap-2">
            <a href="/dashboard" className="inline-flex h-8 items-center rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium hover:bg-neutral-50">{t('common.dashboard')}</a>
            <button type="button" onClick={() => unstable_retry()} className="inline-flex h-8 items-center rounded-lg bg-neutral-900 px-3 text-sm font-medium text-white hover:bg-neutral-700">{t('common.tryAgain')}</button>
          </div>
        </main>
      </body>
    </html>
  )
}
