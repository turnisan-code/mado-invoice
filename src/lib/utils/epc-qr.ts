import QRCode from 'qrcode'
import type { Settings } from '@/types'

/**
 * EPC QR code (GiroCode) for SEPA credit transfers, read by every major European banking app.
 * Spec: EPC069-12 "Quick Response Code: Guidelines to Enable Data Capture for the Initiation of a
 * SEPA Credit Transfer", version 002 (BIC optional, UTF-8).
 */

type BeneficiarySettings = Pick<Settings, 'bank_account_holder' | 'company_name' | 'owner_name'>

// Verification of Payee compares this name with the account holder, so the holder from Settings
// wins over the trade name; the owner's name is the last resort because the name is mandatory.
export function epcBeneficiary(settings: BeneficiarySettings): string {
  return settings.bank_account_holder?.trim() || settings.company_name?.trim() || settings.owner_name?.trim() || ''
}

// The payload is line based, so a line break inside a value would shift every following field.
function field(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

export function buildEpcPayload({
  bic,
  name,
  iban,
  amountEur,
  reference,
}: {
  bic: string
  name: string
  iban: string
  amountEur?: number
  reference: string
}): string {
  const amount = amountEur != null && amountEur >= 0.01 ? `EUR${amountEur.toFixed(2)}` : ''
  return [
    'BCD',
    '002',
    '1',                                      // UTF-8
    'SCT',
    bic.replace(/\s/g, '').toUpperCase().slice(0, 11),
    field(name, 70),
    iban.replace(/\s/g, '').toUpperCase(),
    amount,                                   // empty: the banking app asks for it
    '',                                       // purpose code
    '',                                       // structured creditor reference (RF…)
    field(reference, 140),                    // unstructured remittance information
  ].join('\n')
}

// PNG data URI of the QR code, or null without an IBAN or a beneficiary name.
export async function generateEpcQr(params: {
  bic: string
  name: string
  iban: string
  amountEur?: number
  reference: string
}): Promise<string | null> {
  if (!params.iban.trim() || !params.name.trim()) return null
  try {
    return await QRCode.toDataURL(buildEpcPayload(params), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
      color: { dark: '#000000', light: '#ffffff' },
    })
  } catch {
    return null
  }
}
