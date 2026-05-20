import QRCode from 'qrcode'

/**
 * Generates an EPC QR code (GiroCode) for SEPA bank transfers.
 * Supported by all major European banking apps (George, Sparkasse, etc.)
 * Only makes sense for EUR invoices with IBAN/BIC set.
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
  amountEur: number
  reference: string
}): string {
  // Sanitise: remove spaces from IBAN, truncate fields to spec limits
  const cleanIban = iban.replace(/\s/g, '').toUpperCase()
  const cleanBic = bic.replace(/\s/g, '').toUpperCase().slice(0, 11)
  const cleanName = name.slice(0, 70)
  const cleanRef = reference.slice(0, 35)
  const amountStr = `EUR${amountEur.toFixed(2)}`

  return [
    'BCD',        // Service tag
    '002',        // Version
    '1',          // Character set: UTF-8
    'SCT',        // SEPA Credit Transfer
    cleanBic,     // BIC of beneficiary bank
    cleanName,    // Beneficiary name
    cleanIban,    // Beneficiary IBAN
    amountStr,    // Amount
    '',           // Purpose code (empty)
    '',           // Remittance reference (structured, empty)
    cleanRef,     // Remittance information (unstructured)
  ].join('\n')
}

/**
 * Returns a base64 PNG data URI of the EPC QR code, or null if inputs are invalid.
 */
export async function generateEpcQr(params: {
  bic: string
  name: string
  iban: string
  amountEur: number
  reference: string
}): Promise<string | null> {
  if (!params.iban || !params.name || params.amountEur <= 0) return null
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
