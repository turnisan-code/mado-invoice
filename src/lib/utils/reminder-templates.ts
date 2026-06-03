export interface ReminderContext {
  invoiceNumber: string
  clientName: string
  amount: string
  dueDate: string
  date: string
  daysOverdue: number
  iban: string
  sender: string
  company: string
  owner: string
}

// Single-pass replacement prevents chained injection (e.g. a client name
// containing "{{iban}}" being substituted again in a later pass).
export function fillTemplate(template: string, ctx: ReminderContext): string {
  const map: Record<string, string> = {
    invoice_number: ctx.invoiceNumber,
    client:         ctx.clientName,
    amount:         ctx.amount,
    total:          ctx.amount,
    balance_due:    ctx.amount,
    due_date:       ctx.dueDate,
    date:           ctx.date,
    days_overdue:   String(ctx.daysOverdue),
    iban:           ctx.iban,
    sender:         ctx.sender,
    company:        ctx.company,
    owner:          ctx.owner,
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => map[key] ?? `{{${key}}}`)
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
