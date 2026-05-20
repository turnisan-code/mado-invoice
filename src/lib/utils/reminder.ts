import { google } from 'googleapis'

export interface ReminderContext {
  invoiceNumber: string
  clientName: string
  amount: string
  dueDate: string
  daysOverdue: number
  iban: string
  sender: string
}

export function fillTemplate(template: string, ctx: ReminderContext): string {
  return template
    .replace(/\{\{invoice_number\}\}/g, ctx.invoiceNumber)
    .replace(/\{\{client\}\}/g, ctx.clientName)
    .replace(/\{\{amount\}\}/g, ctx.amount)
    .replace(/\{\{due_date\}\}/g, ctx.dueDate)
    .replace(/\{\{days_overdue\}\}/g, String(ctx.daysOverdue))
    .replace(/\{\{iban\}\}/g, ctx.iban)
    .replace(/\{\{sender\}\}/g, ctx.sender)
}

export const DEFAULT_SUBJECT_DE = 'Zahlungserinnerung: Rechnung {{invoice_number}}'
export const DEFAULT_BODY_DE = `Sehr geehrte(r) {{client}},

wir möchten Sie daran erinnern, dass Rechnung {{invoice_number}} über {{amount}} am {{due_date}} fällig war und nun seit {{days_overdue}} Tagen überfällig ist.

Bitte überweisen Sie den Betrag auf folgende Bankverbindung:
IBAN: {{iban}}

Vielen Dank für Ihre Zahlung.

Mit freundlichen Grüßen,
{{sender}}`

export const DEFAULT_SUBJECT_EN = 'Payment reminder: Invoice {{invoice_number}}'
export const DEFAULT_BODY_EN = `Dear {{client}},

This is a reminder that invoice {{invoice_number}} for {{amount}} was due on {{due_date}} and is now {{days_overdue}} days overdue.

Please transfer the amount to:
IBAN: {{iban}}

Thank you for your prompt payment.

Best regards,
{{sender}}`

function buildMime({ from, to, subject, body }: {
  from: string; to: string; subject: string; body: string
}) {
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
  from, to, subject, body,
  onTokenRefresh,
}: {
  accessToken: string
  refreshToken: string
  tokenExpiry: number | null
  from: string
  to: string
  subject: string
  body: string
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
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date,
      })
    })
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2 })
  const raw = buildMime({ from, to, subject, body })
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
}
