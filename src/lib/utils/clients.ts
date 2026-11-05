import type { SupabaseClient } from '@supabase/supabase-js'
import type { Client, ClientDefaults, Settings } from '@/types'
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

type SearchableClient = NamedClient & {
  client_number?: string | null
  email?: string | null
  city?: string | null
  uid_number?: string | null
  tags?: string[] | null
}

const compact = (s: string) => s.replace(/\s+/g, '').toLowerCase()

// The client list's search: number, name, company, email, city, VAT ID and tags. A VAT ID
// matches with or without the spaces it is often written with (ATU 123 456 78).
export function clientMatches(c: SearchableClient, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const text = [c.client_number, c.name, c.company, c.email, c.city, c.uid_number, ...(c.tags ?? [])].filter(Boolean).join(' ').toLowerCase()
  return text.includes(needle) || (!!c.uid_number && compact(c.uid_number).includes(compact(needle)))
}

// "Acme GmbH (Jane Doe)" when both exist, for pickers where the contact disambiguates.
export function clientLabel(c: NamedClient | null | undefined): string {
  if (c?.company && c.name) return `${c.company} (${c.name})`
  return clientDisplayName(c)
}

// "K-0007 · Acme GmbH": how a client is told apart from a namesake.
export function clientWithNumber(c: NamedClient & { client_number?: string | null }): string {
  return [c.client_number, clientDisplayName(c)].filter(Boolean).join(' · ')
}

export type DuplicateReason = 'email' | 'uid'
export interface ClientDuplicate { client: Client; reasons: DuplicateReason[] }

// ilike treats % and _ as wildcards; an email may contain both.
const escapeLike = (v: string) => v.replace(/[\\%_]/g, ch => `\\${ch}`)

// Clients that already have this email address (in any case) or VAT ID (normalized, as stored),
// checked before a client is created or changed. Only a warning: a failed lookup finds nothing,
// so it never blocks saving.
export async function findDuplicateClients(
  supabase: SupabaseClient,
  { email, uid }: { email?: string | null; uid?: string | null },
  exceptId?: string,
): Promise<ClientDuplicate[]> {
  async function lookup(reason: DuplicateReason, value: string) {
    let q = supabase.from('clients').select('*')
    q = reason === 'email' ? q.ilike('email', escapeLike(value)) : q.eq('uid_number', value)
    if (exceptId) q = q.neq('id', exceptId)
    const { data, error } = await q.limit(5)
    if (error) console.error('[clients] duplicate check failed:', error.code, error.message)
    return ((data ?? []) as Client[]).map(client => ({ client, reason }))
  }
  const lookups: ReturnType<typeof lookup>[] = []
  if (email?.trim()) lookups.push(lookup('email', email.trim()))
  if (uid?.trim()) lookups.push(lookup('uid', uid.trim()))
  const found = new Map<string, ClientDuplicate>()
  for (const { client, reason } of (await Promise.all(lookups)).flat()) {
    const entry = found.get(client.id) ?? { client, reasons: [] }
    entry.reasons.push(reason)
    found.set(client.id, entry)
  }
  return [...found.values()]
}

export type ClientDefaultsSource = Pick<Settings, 'country' | 'default_tax_treatment' | 'default_language' | 'default_payment_days'>

export const CLIENT_DEFAULTS_COLUMNS = 'country, default_tax_treatment, default_language, default_payment_days, default_skonto_percent, default_skonto_days'

// A new client starts in the studio's own country with the document defaults from Settings.
export function toClientDefaults(s: (ClientDefaultsSource & Partial<Pick<Settings, 'default_skonto_percent' | 'default_skonto_days'>>) | null | undefined): ClientDefaults {
  return {
    country: toCountryCode(s?.country) ?? 'AT',
    tax_treatment: s?.default_tax_treatment ?? 'at_vat',
    language: s?.default_language ?? 'de',
    payment_days: s?.default_payment_days ?? 14,
    skonto_percent: s?.default_skonto_percent ?? null,
    skonto_days: s?.default_skonto_days ?? null,
  }
}
