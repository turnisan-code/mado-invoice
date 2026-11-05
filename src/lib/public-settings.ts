import type { Settings } from '@/types'

export type SecretSettingsKey = 'gmail_access_token' | 'gmail_refresh_token' | 'gmail_token_expiry' | 'bookamat_api_key'

export type PublicSettings = Omit<Settings, SecretSettingsKey> & {
  gmail_connected: boolean
  // The account is still on record but its tokens are gone (revoked, invalid_grant): reconnect.
  google_expired: boolean
  drive_configured: boolean
  bookamat_key_saved: boolean
  bookamat_configured: boolean
}

const SECRET_KEYS: readonly SecretSettingsKey[] = ['gmail_access_token', 'gmail_refresh_token', 'gmail_token_expiry', 'bookamat_api_key']

type BookamatCore = Pick<Settings, 'bookamat_username' | 'bookamat_api_key' | 'bookamat_bank_account_id' | 'bookamat_cost_account_id'>

// Everything a sync needs before it looks at the document: credentials, the bank account money
// arrives on and the income account. Cash and VAT accounts are checked per document.
export function isBookamatConfigured(settings: BookamatCore): boolean {
  return Boolean(settings.bookamat_username && settings.bookamat_api_key && settings.bookamat_bank_account_id && settings.bookamat_cost_account_id)
}

export function isGoogleExpired(settings: Pick<Settings, 'gmail_email' | 'gmail_refresh_token'>): boolean {
  return Boolean(settings.gmail_email && !settings.gmail_refresh_token)
}

export function toPublicSettings(settings: Settings): PublicSettings {
  const publicFields: Partial<Settings> = { ...settings }
  for (const key of SECRET_KEYS) delete publicFields[key]
  const gmailConnected = Boolean(settings.gmail_refresh_token)
  return {
    ...(publicFields as Omit<Settings, SecretSettingsKey>),
    // A folder without a Google connection cannot be written to; pages that test the folder id
    // must not offer Drive then.
    drive_folder_id: gmailConnected ? settings.drive_folder_id : null,
    gmail_connected: gmailConnected,
    google_expired: isGoogleExpired(settings),
    drive_configured: gmailConnected && Boolean(settings.drive_folder_id),
    bookamat_key_saved: Boolean(settings.bookamat_username && settings.bookamat_api_key),
    bookamat_configured: isBookamatConfigured(settings),
  }
}
