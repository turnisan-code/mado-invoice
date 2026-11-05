import { NextResponse } from 'next/server'
import { apiError, invalidJson, isUuid, readJsonObject, requireUser, serviceErrorResponse } from '@/lib/auth'
import { getUiLang } from '@/lib/i18n/server'
import { ServiceError } from '@/lib/services/errors'
import { createAdvanceInvoice } from '@/lib/services/quotes'
import { formatMoney } from '@/lib/utils/document'

// An advance invoice for part of a sent or accepted quote (createAdvanceInvoice):
// { mode: 'percent', value: 30 } or { mode: 'amount', value: 1500 } (gross).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Quote not found')

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  const mode = body.mode === 'percent' || body.mode === 'amount' ? body.mode : null
  const value = typeof body.value === 'number' && Number.isFinite(body.value) ? body.value : null
  if (!mode || value == null || value <= 0 || (mode === 'percent' && value > 100)) {
    return apiError(400, 'deposit_bad_amount', 'Expected a percentage up to 100 or an amount above zero')
  }

  try {
    const { invoiceId } = await createAdvanceInvoice(supabase, id, { mode, value })
    return NextResponse.json({ invoiceId })
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'exceeds_quote') {
      const uiLang = await getUiLang()
      const { amount, total } = err.details as { amount: number; total: number }
      return apiError(409, 'exceeds_quote', err.message, {
        details: { amount: formatMoney(amount, 'EUR', uiLang), total: formatMoney(total, 'EUR', uiLang) },
      })
    }
    return serviceErrorResponse(err)
  }
}
