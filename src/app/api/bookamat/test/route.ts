import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { BOOKAMAT_SETTINGS_COLUMNS, BookamatError, credentialsOf, fetchBookamatAccounts, recordBookamatError, type BookamatSettings } from '@/lib/bookamat'
import { today } from '@/lib/utils/document'

// Settings → Bookamat → Test connection: the stored credentials reach Bookamat and every
// configured account still exists in the year it was chosen in. Success clears the last error.
export async function POST() {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const { data, error } = await supabase.from('settings').select(BOOKAMAT_SETTINGS_COLUMNS).single()
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'Settings not found' }, { status: 500 })
  const settings = data as unknown as BookamatSettings
  if (!settings.bookamat_username || !settings.bookamat_api_key) {
    return NextResponse.json({ error: 'Bookamat is not configured', code: 'not_configured' }, { status: 400 })
  }

  const year = settings.bookamat_accounts_year ?? Number(today().slice(0, 4))
  try {
    const accounts = await fetchBookamatAccounts(credentialsOf(settings), year)
    const checks: [string, number | null, { id: number }[]][] = [
      ['bank', settings.bookamat_bank_account_id, accounts.bankAccounts],
      ['cash', settings.bookamat_cash_account_id, accounts.bankAccounts],
      ['income', settings.bookamat_cost_account_id, accounts.costAccounts],
      ['vat0', settings.bookamat_vat_account_0, accounts.vatAccounts],
      ['vatRc', settings.bookamat_vat_account_rc, accounts.vatAccounts],
      ['vatNonEu', settings.bookamat_vat_account_non_eu, accounts.vatAccounts],
      ['vat10', settings.bookamat_vat_account_10, accounts.vatAccounts],
      ['vat13', settings.bookamat_vat_account_13, accounts.vatAccounts],
      ['vat20', settings.bookamat_vat_account_20, accounts.vatAccounts],
    ]
    const missing = checks.filter(([, id, list]) => id != null && !list.some(a => a.id === id)).map(([key]) => key)
    if (missing.length) {
      const message = `Configured Bookamat accounts missing in ${year}: ${missing.join(', ')}`
      await recordBookamatError(supabase, settings.id, null, message)
      return NextResponse.json({ error: message, code: 'account_missing', detail: { year, account: missing.join(', ') } }, { status: 400 })
    }
    await recordBookamatError(supabase, settings.id, null, null)
    return NextResponse.json({ ok: true, year })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bookamat request failed'
    await recordBookamatError(supabase, settings.id, null, message)
    const e = err instanceof BookamatError ? err : null
    return NextResponse.json({ error: message, code: e?.code, detail: e?.detail }, { status: 502 })
  }
}
