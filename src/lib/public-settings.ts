import type { Settings } from '@/types'

export type SecretSettingsKey = 'gmail_access_token' | 'gmail_refresh_token' | 'gmail_token_expiry' | 'bookamat_api_key'

export type PublicSettings = Omit<Settings, SecretSettingsKey> & {
  gmail_connected: boolean
  bookamat_configured: boolean
}

const SECRET_KEYS: readonly SecretSettingsKey[] = ['gmail_access_token', 'gmail_refresh_token', 'gmail_token_expiry', 'bookamat_api_key']

export function toPublicSettings(settings: Settings): PublicSettings {
  const publicFields: Partial<Settings> = { ...settings }
  for (const key of SECRET_KEYS) delete publicFields[key]
  return {
    ...(publicFields as Omit<Settings, SecretSettingsKey>),
    gmail_connected: Boolean(settings.gmail_refresh_token),
    bookamat_configured: Boolean(settings.bookamat_username && settings.bookamat_api_key),
  }
}
