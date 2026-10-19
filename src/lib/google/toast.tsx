import { toast } from 'sonner'
import { GOOGLE_REAUTH_CODE } from './reauth'

export function toastApiError(payload: unknown, prefix = '', fallback = 'Unknown error') {
  const p = (payload && typeof payload === 'object' ? payload : {}) as { error?: unknown; code?: unknown }
  const message = typeof p.error === 'string' && p.error ? p.error : fallback
  if (p.code === GOOGLE_REAUTH_CODE) {
    toast.error(
      <span>{message}. <a href="/settings" className="underline">Open Settings →</a></span>,
      { duration: 8000 },
    )
    return
  }
  toast.error(`${prefix}${message}`)
}
