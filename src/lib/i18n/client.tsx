'use client'

import { createContext, useContext, useMemo } from 'react'
import { makeT, type TFn, type UiLang } from './index'

const LanguageContext = createContext<UiLang>('en')

export function LanguageProvider({ lang, children }: { lang: UiLang; children: React.ReactNode }) {
  return <LanguageContext.Provider value={lang}>{children}</LanguageContext.Provider>
}

export function useT(): { t: TFn; lang: UiLang } {
  const lang = useContext(LanguageContext)
  return useMemo(() => ({ t: makeT(lang), lang }), [lang])
}
