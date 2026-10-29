import { toast } from 'sonner'
import { GOOGLE_REAUTH_CODE } from './reauth'
import { apiErrorMessage } from '@/lib/api-errors'
import type { TFn } from '@/lib/i18n'

export function toastApiError(t: TFn, payload: unknown, prefix = '', fallback = t('messages.generic')) {
  const p = (payload && typeof payload === 'object' ? payload : {}) as { error?: unknown; code?: unknown }
  const message = apiErrorMessage(t, payload, fallback)
  if (p.code === GOOGLE_REAUTH_CODE) {
    toast.error(
      <span>{message}. <a href="/settings" className="underline">{t('toasts.openSettings')}</a></span>,
      { duration: 8000 },
    )
    return
  }
  toast.error(`${prefix}${message}`)
}
