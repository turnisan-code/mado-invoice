import type { ClientDefaults, Settings } from '@/types'
import { toCountryCode } from './country'

// One rule for every place that names a client: the company when there is one, else the
// contact name. A client has either or both, never neither.
export interface NamedClient {
  name: string | null
  company: string | null
}

export function clientDisplayName(c: NamedClient | null | undefined): string {
  return c?.company || c?.name || ''
}

// "Acme GmbH (Jane Doe)" when both exist, for pickers where the contact disambiguates.
export function clientLabel(c: NamedClient | null | undefined): string {
  if (c?.company && c.name) return `${c.company} (${c.name})`
  return clientDisplayName(c)
}

export type ClientDefaultsSource = Pick<Settings, 'country' | 'default_tax_treatment' | 'default_language' | 'default_payment_days'>

export const CLIENT_DEFAULTS_COLUMNS = 'country, default_tax_treatment, default_language, default_payment_days'

// A new client starts in the studio's own country with the document defaults from Settings.
export function toClientDefaults(s: ClientDefaultsSource | null | undefined): ClientDefaults {
  return {
    country: toCountryCode(s?.country) ?? 'AT',
    tax_treatment: s?.default_tax_treatment ?? 'at_vat',
    language: s?.default_language ?? 'de',
    payment_days: s?.default_payment_days ?? 14,
  }
}
