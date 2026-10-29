import type { DictKey, TFn } from '@/lib/i18n'

export const GOOGLE_REAUTH_CODE = 'google_reauth'
export const GOOGLE_REAUTH_MESSAGE = 'Google connection expired — reconnect in Settings'
export const GOOGLE_SCOPE_MESSAGE = 'Google connection is missing the Drive permission — reconnect in Settings'
export const GOOGLE_NOT_CONNECTED_MESSAGE = 'Google not connected — connect it in Settings'
export const GOOGLE_FOLDER_TRASHED_MESSAGE = 'The Drive folder is in the trash'

const WORDED: Record<string, DictKey> = {
  [GOOGLE_REAUTH_MESSAGE]: 'books.google.expired',
  [GOOGLE_SCOPE_MESSAGE]: 'books.google.missingDrive',
  [GOOGLE_NOT_CONNECTED_MESSAGE]: 'books.google.notConnected',
  [GOOGLE_FOLDER_TRASHED_MESSAGE]: 'books.google.folderTrashed',
}

// Google errors are returned and saved (settings.google_last_error) as the messages above or as
// Google's own text; the UI words the known ones in its language.
export function googleErrorText(t: TFn, message: string): string {
  const key = WORDED[message]
  return key ? t(key) : message
}
