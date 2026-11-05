// Clients as the client form, the editor's quick add and the Claude connector write them: one
// validation, one payload, one write. Browser-safe (supabase-js and pure helpers only).
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { TFn } from '@/lib/i18n'
import { parseEmailList } from '@/lib/templates'
import { isCountryCode, toCountryCode } from '@/lib/utils/country'
import { isValidEmail, isValidVatId, normalizeVatId } from '@/lib/utils/validation'
import type { Client, ClientDefaults } from '@/types'

export function clientSchema(t: TFn) {
  return z.object({
    name: z.string(),
    company: z.string(),
    address_line1: z.string(),
    address_line2: z.string(),
    zip: z.string(),
    city: z.string(),
    country: z.string().refine(isCountryCode, t('clients.form.countryRequired')),
    email: z.string().refine(v => !v.trim() || isValidEmail(v), t('clients.form.emailInvalid')),
    phone: z.string(),
    uid_number: z.string().refine(v => !normalizeVatId(v) || isValidVatId(v), t('clients.form.uidInvalid')),
    tax_treatment: z.enum(['at_vat', 'eu_reverse_charge', 'non_eu']),
    language: z.enum(['de', 'en']),
    payment_days: z.number().int(t('clients.form.paymentDaysInvalid')).min(0, t('clients.form.paymentDaysInvalid')).max(365, t('clients.form.paymentDaysInvalid')).nullable(),
    skonto_percent: z.number().min(0, t('rates.skontoPercentInvalid')).max(100, t('rates.skontoPercentInvalid')).nullable(),
    skonto_days: z.number().int(t('rates.skontoDaysInvalid')).min(0, t('rates.skontoDaysInvalid')).max(365, t('rates.skontoDaysInvalid')).nullable(),
    status: z.enum(['active', 'inactive', 'lead']),
    tags: z.array(z.string()),
    notes: z.string(),
    reminders_opt_out: z.boolean(),
    cc_emails: z.string().superRefine((v, ctx) => {
      const { invalid } = parseEmailList(v)
      if (invalid.length) ctx.addIssue({ code: 'custom', message: t('dunning.invalidAddresses', { list: invalid.join(', ') }) })
    }),
    einvoice_format: z.enum(['', 'ebinterface', 'ubl']),
    peppol_scheme: z.string().refine(v => !v.trim() || /^\d{4}$/.test(v.trim()), t('einvoice.client.schemeInvalid')),
    peppol_id: z.string(),
    buyer_reference: z.string(),
    supplier_number: z.string(),
  }).refine(v => v.name.trim() || v.company.trim(), { path: ['name'], message: t('clients.form.nameRequired') })
    .refine(v => !v.peppol_scheme.trim() === !v.peppol_id.trim(), { path: ['peppol_id'], message: t('einvoice.client.incomplete') })
}

export type ClientValues = z.infer<ReturnType<typeof clientSchema>>

export function toClientValues(client: Client | undefined, defaults: ClientDefaults): ClientValues {
  return {
    name: client?.name ?? '',
    company: client?.company ?? '',
    address_line1: client?.address_line1 ?? '',
    address_line2: client?.address_line2 ?? '',
    zip: client?.zip ?? '',
    city: client?.city ?? '',
    // An old free-text country that maps to a code is corrected silently; anything else stays visible.
    country: client ? toCountryCode(client.country) ?? client.country : defaults.country,
    email: client?.email ?? '',
    phone: client?.phone ?? '',
    uid_number: client?.uid_number ?? '',
    tax_treatment: client?.tax_treatment ?? defaults.tax_treatment,
    language: client?.language ?? defaults.language,
    payment_days: client ? client.payment_days : null,
    skonto_percent: client?.skonto_percent ?? null,
    skonto_days: client?.skonto_days ?? null,
    status: client?.status ?? 'active',
    tags: client?.tags ?? [],
    notes: client?.notes ?? '',
    reminders_opt_out: client?.reminders_opt_out ?? false,
    cc_emails: (client?.cc_emails ?? []).join(', '),
    einvoice_format: client?.einvoice_format ?? '',
    peppol_scheme: client?.peppol_scheme ?? '',
    peppol_id: client?.peppol_id ?? '',
    buyer_reference: client?.buyer_reference ?? '',
    supplier_number: client?.supplier_number ?? '',
  }
}

export function toClientPayload(v: ClientValues) {
  return {
    name: v.name.trim(),
    company: v.company.trim() || null,
    address_line1: v.address_line1.trim(),
    address_line2: v.address_line2.trim() || null,
    zip: v.zip.trim(),
    city: v.city.trim(),
    country: v.country,
    email: v.email.trim(),
    phone: v.phone.trim() || null,
    uid_number: normalizeVatId(v.uid_number) || null,
    tax_treatment: v.tax_treatment,
    language: v.language,
    currency: 'EUR' as const,
    payment_days: v.payment_days,
    skonto_percent: v.skonto_percent,
    skonto_days: v.skonto_days,
    status: v.status,
    tags: v.tags,
    notes: v.notes.trim() || null,
    reminders_opt_out: v.reminders_opt_out,
    cc_emails: parseEmailList(v.cc_emails).emails,
    einvoice_format: v.einvoice_format || null,
    peppol_scheme: v.peppol_scheme.trim() || null,
    peppol_id: v.peppol_id.trim() || null,
    buyer_reference: v.buyer_reference.trim() || null,
    supplier_number: v.supplier_number.trim() || null,
  }
}

export type ClientPayload = ReturnType<typeof toClientPayload>

// What the editor's quick add stores: who, where and the UID; the rest is the database's defaults
// until the client's page fills it in.
export function quickClientPayload(v: { name: string; company: string; email: string; country: string; vatId: string; tax: Client['tax_treatment']; language: Client['language'] }) {
  return {
    name: v.name.trim(),
    company: v.company.trim() || null,
    email: v.email.trim(),
    country: v.country,
    uid_number: normalizeVatId(v.vatId) || null,
    tax_treatment: v.tax,
    language: v.language,
    currency: 'EUR' as const,
    payment_days: null,
    status: 'active' as const,
  }
}

type ClientWrite = Partial<ClientPayload>

// Inserts a client (the database assigns its number) or updates one. `client` is the stored row;
// an update that matched nothing (deleted meanwhile) has none and no error.
export async function saveClient(
  supabase: SupabaseClient,
  payload: ClientWrite,
  id?: string,
): Promise<{ client: Client | null; error: PostgrestError | null }> {
  if (id) {
    const { data, error } = await supabase.from('clients').update(payload).eq('id', id).select('*')
    return { client: ((data ?? [])[0] as Client | undefined) ?? null, error }
  }
  const { data, error } = await supabase.from('clients').insert(payload).select('*').single()
  return { client: (data as Client | null) ?? null, error }
}
