import QRCode from 'qrcode'

/**
 * Generates an EPC QR code (GiroCode) for SEPA bank transfers.
 * Supported by all major European banking apps (George, Sparkasse, etc.)
 *
 * For EUR invoices the amount is pre-filled. For non-EUR invoices (e.g. GBP, USD)
 * the amount field is left empty — banking apps will prompt the user to enter it,
 * but IBAN and reference are still pre-filled.
 *
 * Spec: https://www.europeanpaymentscouncil.eu/document-library/guidance-documents/quick-response-code-guidelines-enable-data-capture-initiation
 */
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
  amountEur?: number  // omit for non-EUR invoices
  reference: string
}): string {
  const cleanIban = iban.replace(/\s/g, '').toUpperCase()
  const cleanBic = bic.replace(/\s/g, '').toUpperCase().slice(0, 11)
  const cleanName = name.slice(0, 70)
  const cleanRef = reference.slice(0, 35)
  // Amount is optional in EPC spec — omit for non-EUR so the bank app asks the user
  const amountStr = amountEur != null && amountEur > 0 ? `EUR${amountEur.toFixed(2)}` : ''

  return [
    'BCD',        // Service tag
    '002',        // Version
    '1',          // Character set: UTF-8
    'SCT',        // SEPA Credit Transfer
    cleanBic,     // BIC of beneficiary bank
    cleanName,    // Beneficiary name
    cleanIban,    // Beneficiary IBAN
    amountStr,    // Amount (empty = bank app asks user)
    '',           // Purpose code (empty)
    '',           // Remittance reference (structured, empty)
    cleanRef,     // Remittance information (unstructured)
  ].join('\n')
}

/**
 * Returns a base64 PNG data URI of the EPC QR code, or null if IBAN is missing.
 * Works for any invoice currency — EUR invoices get the amount pre-filled,
 * non-EUR invoices get IBAN + reference pre-filled (amount left for user to enter).
 */
export async function generateEpcQr(params: {
  bic: string
  name: string
  iban: string
  amountEur?: number
  reference: string
}): Promise<string | null> {
  if (!params.iban || !params.name) return null
  try {
    const payload = buildEpcPayload(params)
    const dataUri = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 120,
      color: { dark: '#000000', light: '#ffffff' },
    })
    return dataUri
  } catch {
    return null
  }
}
