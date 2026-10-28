import { randomBytes, randomUUID } from 'crypto'
import { google } from 'googleapis'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { GoogleAuth } from '@/lib/google/client'
import { portalUrl } from '@/lib/templates'

export {
  reminderTitle, nextReminderLevel, daysBetween, reminderFigures, reminderVariables, reminderTemplates,
  type ReminderFigures,
} from './reminder-templates'

export interface MailAttachment {
  filename: string
  content: Buffer
  contentType?: string
}

export interface MailMessage {
  from: string
  to: string
  cc?: readonly string[]
  bcc?: readonly string[]
  subject: string
  body: string
  attachments?: readonly MailAttachment[]
}

// Callers pass validated addresses; this strips anything that could still end a header line.
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function encodedWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(headerValue(value)).toString('base64')}?=`
}

function base64Lines(content: Buffer): string {
  return content.toString('base64').replace(/.{76}(?=.)/g, '$&\r\n')
}

// RFC 2231 filename with an ASCII fallback for clients that ignore filename*.
function dispositionFilename(filename: string): string {
  const clean = headerValue(filename).replace(/["\\]/g, '_')
  const ascii = clean.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_')
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`
}

// Gmail removes the Bcc header from the copies it delivers.
export function buildMime({ from, to, cc = [], bcc = [], subject, body, attachments = [] }: MailMessage): string {
  const headers = [
    `From: ${headerValue(from)}`,
    `To: ${headerValue(to)}`,
    ...(cc.length ? [`Cc: ${cc.map(headerValue).join(', ')}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.map(headerValue).join(', ')}`] : []),
    `Subject: ${encodedWord(subject)}`,
    'MIME-Version: 1.0',
  ]
  const text = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(Buffer.from(body.replace(/\r?\n/g, '\r\n')))]

  if (!attachments.length) return Buffer.from([...headers, ...text].join('\r\n')).toString('base64url')

  const boundary = `mado_${randomBytes(12).toString('hex')}`
  const lines = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...text]
  for (const a of attachments) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType ?? 'application/pdf'}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${dispositionFilename(a.filename)}`,
      '',
      base64Lines(a.content),
    )
  }
  lines.push(`--${boundary}--`, '')
  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

export async function sendGmail(auth: GoogleAuth, message: MailMessage): Promise<void> {
  const gmail = google.gmail({ version: 'v1', auth })
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: buildMime(message) } })
}

// Where links in emails point: the configured public origin, else the origin the request came in on.
export function appOrigin(requestOrigin: string): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || requestOrigin
}

// The document's client-portal link, created on first use like the Share button does.
export async function ensurePortalLink(supabase: SupabaseClient, doc: { id: string; share_token?: string | null }, origin: string): Promise<string> {
  if (doc.share_token) return portalUrl(origin, doc.share_token)
  const token = randomUUID()
  const { data, error } = await supabase
    .from('documents')
    .update({ share_token: token })
    .eq('id', doc.id)
    .is('share_token', null)
    .not('number', 'is', null)
    .select('share_token')
  if (error) throw new Error(error.message)
  if (data?.length) return portalUrl(origin, token)
  const { data: current, error: readErr } = await supabase.from('documents').select('share_token').eq('id', doc.id).maybeSingle()
  if (readErr) throw new Error(readErr.message)
  if (!current?.share_token) throw new Error('Only issued documents can be shared')
  return portalUrl(origin, current.share_token)
}
