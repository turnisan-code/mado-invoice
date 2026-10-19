import { google } from 'googleapis'
import type { GoogleAuth } from '@/lib/google/client'

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
  auth, from, to, subject, body, pdfBase64, filename,
}: {
  auth: GoogleAuth
  from: string
  to: string
  subject: string
  body: string
  pdfBase64?: string
  filename?: string
}) {
  const gmail = google.gmail({ version: 'v1', auth })
  const raw = buildMime({ from, to, subject, body, pdfBase64, filename })
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
}
