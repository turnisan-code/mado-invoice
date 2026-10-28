'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Languages } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/lib/i18n/client'
import { UI_LANGS, type UiLang } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const LANGUAGE_NAMES: Record<UiLang, string> = { de: 'Deutsch', en: 'English' }

// Compact "DE | EN" switch for the sidebar footer and the mobile "More" sheet. The language lives
// in settings, so the server re-renders every page in the new language after router.refresh().
export default function LanguageToggle({ className, iconSize = 16 }: { className?: string; iconSize?: number }) {
  const { t, lang } = useT()
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function switchTo(next: UiLang) {
    if (next === lang || busy) return
    setBusy(true)
    const res = await fetch('/api/settings/ui-language', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: next }),
    })
    setBusy(false)
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: t('common.unknownError') }))
      toast.error(error)
      return
    }
    router.refresh()
  }

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <Languages size={iconSize} aria-hidden="true" />
      <div role="group" aria-label={t('nav.language')} className="flex items-center gap-1 text-sm">
        {UI_LANGS.map((code, i) => (
          <span key={code} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden="true" className="text-neutral-300 dark:text-neutral-600">|</span>}
            <button
              type="button"
              onClick={() => switchTo(code)}
              disabled={busy}
              aria-pressed={lang === code}
              aria-label={t('nav.switchTo', { language: LANGUAGE_NAMES[code] })}
              className={cn(
                'px-1 rounded transition-colors disabled:opacity-50',
                lang === code ? 'font-semibold text-neutral-900 dark:text-neutral-100' : 'hover:text-neutral-700 dark:hover:text-neutral-200',
              )}
            >
              {code.toUpperCase()}
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}
