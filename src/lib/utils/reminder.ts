import { google } from 'googleapis'

export type { ReminderContext } from './reminder-templates'
export { fillTemplate, DEFAULT_SUBJECT_DE, DEFAULT_BODY_DE, DEFAULT_SUBJECT_EN, DEFAULT_BODY_EN } from './reminder-templates'

export function buildMime({ from, to, subject, body, pdfBase64, filename }: {
  from: string; to: string; subject: string; body: string
  pdfBase64?: string; filename?: string
}) {
  if (pdfBase64 && filename) {
    // Multipart with PDF attachment
    const boundary = `boundary_${Date.now()}`
    const lines = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      body,
      '',
      `--${boundary}`,
      'Content-Type: application/pdf',
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      pdfBase64,
      '',
      `--${boundary}--`,
    ]
    return Buffer.from(lines.join('\r\n')).toString('base64url')
  }
  // Plain text only
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body).toString('base64'),
  ]
  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

export async function sendReminderEmail({
  accessToken, refreshToken, tokenExpiry,
  from, to, subject, body, pdfBase64, filename,
  onTokenRefresh,
}: {
  accessToken: string
  refreshToken: string
  tokenExpiry: number | null
  from: string
  to: string
  subject: string
  body: string
  pdfBase64?: string
  filename?: string
  onTokenRefresh?: (tokens: { access_token: string | null; refresh_token?: string | null; expiry_date?: number | null }) => Promise<void>
}) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXT_PUBLIC_APP_URL}/api/gmail/callback`,
  )
  oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken, expiry_date: tokenExpiry ?? undefined })

  if (onTokenRefresh) {
    oauth2.on('tokens', async (tokens) => {
      await onTokenRefresh({
        access_token: tokens.access_token ?? null,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date,
      })
    })
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2 })
  const raw = buildMime({ from, to, subject, body, pdfBase64, filename })
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
}
