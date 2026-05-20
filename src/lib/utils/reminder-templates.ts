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
