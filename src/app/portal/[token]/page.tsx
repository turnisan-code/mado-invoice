import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/service'
import { calcTotals, formatMoney, formatDate } from '@/lib/utils/document'
import { Download } from 'lucide-react'
import type { Settings, Client, DocumentItem, Payment, DocumentType, Language } from '@/types'

const STATUS_LABEL: Record<string, { de: string; en: string }> = {
  draft:     { de: 'Entwurf',    en: 'Draft' },
  sent:      { de: 'Gesendet',   en: 'Sent' },
  paid:      { de: 'Bezahlt',    en: 'Paid' },
  overdue:   { de: 'Überfällig', en: 'Overdue' },
  accepted:  { de: 'Akzeptiert', en: 'Accepted' },
  rejected:  { de: 'Abgelehnt',  en: 'Rejected' },
  cancelled: { de: 'Storniert',  en: 'Cancelled' },
}

const STATUS_COLOR: Record<string, string> = {
  paid:      'bg-green-100 text-green-800 border border-green-200',
  overdue:   'bg-red-100 text-red-800 border border-red-200',
  sent:      'bg-blue-100 text-blue-800 border border-blue-200',
  accepted:  'bg-green-100 text-green-800 border border-green-200',
  rejected:  'bg-red-100 text-red-800 border border-red-200',
  cancelled: 'bg-neutral-100 text-neutral-500 border border-neutral-200',
  draft:     'bg-neutral-100 text-neutral-500 border border-neutral-200',
}

const DOC_TITLE: Record<DocumentType, { de: string; en: string }> = {
  invoice:     { de: 'Rechnung',  en: 'Invoice' },
  quote:       { de: 'Angebot',   en: 'Quote' },
  credit_note: { de: 'Gutschrift', en: 'Credit Note' },
}

const L: Record<string, { de: string; en: string }> = {
  billed_to:   { de: 'Rechnungsempfänger', en: 'Billed to' },
  date:        { de: 'Datum',              en: 'Date' },
  due_date:    { de: 'Fälligkeitsdatum',   en: 'Due date' },
  valid_until: { de: 'Gültig bis',         en: 'Valid until' },
  service_date:{ de: 'Leistungsdatum',     en: 'Service date' },
  description: { de: 'Beschreibung',       en: 'Description' },
  qty:         { de: 'Menge',              en: 'Qty' },
  rate:        { de: 'Preis',              en: 'Rate' },
  amount:      { de: 'Betrag',             en: 'Amount' },
  subtotal:    { de: 'Nettobetrag',        en: 'Subtotal' },
  discount:    { de: 'Rabatt',             en: 'Discount' },
  vat:         { de: 'MwSt.',              en: 'VAT' },
  total:       { de: 'Gesamtbetrag',       en: 'Total' },
  balance_due: { de: 'Offen',              en: 'Balance due' },
  paid_amount: { de: 'Bezahlt',            en: 'Paid' },
  payment_info:{ de: 'Zahlungsinformationen', en: 'Payment info' },
  notes:       { de: 'Hinweise',           en: 'Notes' },
  download_pdf:{ de: 'PDF herunterladen',  en: 'Download PDF' },
  uid:         { de: 'UID-Nr.',            en: 'VAT Reg.' },
}

function t(key: string, lang: Language) { return L[key]?.[lang] ?? key }

export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: doc } = await supabase
    .from('documents')
    .select('*, document_items(*), payments(*), clients(*)')
    .eq('share_token', token)
    .single()

  if (!doc) notFound()

  const settings = (await supabase.from('settings').select('*').single()).data as Settings | null
  if (!settings) notFound()

  const client = doc.clients as unknown as Client
  const items = (doc.document_items ?? []) as DocumentItem[]
  const payments = (doc.payments ?? []) as Payment[]
  const lang = (doc.language ?? 'de') as Language
  const totals = calcTotals(items, payments, doc.discount_type && doc.discount_value ? { type: doc.discount_type, value: doc.discount_value } : null)
  const fmt = (n: number) => formatMoney(n, doc.currency ?? 'EUR')
  const docType = doc.type as DocumentType

  const showPaymentInfo = (doc.status === 'sent' || doc.status === 'overdue') && docType === 'invoice'

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">

          {/* Header */}
          <div className="flex items-start justify-between mb-8">
            <div>
              {settings.logo_url
                ? <img src={settings.logo_url} alt={settings.company_name} className="h-12 object-contain object-left mb-3" />
                : <div className="text-xl font-bold text-neutral-900 mb-3">{settings.company_name}</div>
              }
              <div className="text-sm text-neutral-500 space-y-0.5">
                <div>{settings.address_line1}</div>
                {settings.address_line2 && <div>{settings.address_line2}</div>}
                <div>{settings.zip} {settings.city}</div>
                {settings.email && <div>{settings.email}</div>}
              </div>
            </div>
            <div className="text-right space-y-1">
              <div className="text-2xl font-bold text-neutral-900">{DOC_TITLE[docType][lang]}</div>
              <div className="text-sm text-neutral-500">{doc.number}</div>
              <span className={`inline-block text-xs px-2.5 py-0.5 rounded-full font-medium ${STATUS_COLOR[doc.status] ?? ''}`}>
                {STATUS_LABEL[doc.status]?.[lang] ?? doc.status}
              </span>
            </div>
          </div>

          {/* Meta + Billed to */}
          <div className="grid grid-cols-2 gap-6 mb-8">
            <div>
              <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wide mb-2">{t('billed_to', lang)}</div>
              <div className="text-sm text-neutral-700 space-y-0.5">
                {client.company && <div className="font-medium">{client.company}</div>}
                <div className={client.company ? '' : 'font-medium'}>{client.name}</div>
                <div>{client.address_line1}</div>
                {client.address_line2 && <div>{client.address_line2}</div>}
                <div>{client.zip} {client.city}</div>
                <div>{client.country}</div>
                {client.uid_number && <div className="text-neutral-500 text-xs mt-1">{t('uid', lang)}: {client.uid_number}</div>}
              </div>
            </div>
            <div className="text-sm space-y-2">
              <div className="flex justify-between">
                <span className="text-neutral-500">{t('date', lang)}</span>
                <span className="font-medium">{formatDate(doc.date, lang)}</span>
              </div>
              {doc.service_date && (
                <div className="flex justify-between">
                  <span className="text-neutral-500">{t('service_date', lang)}</span>
                  <span className="font-medium">{formatDate(doc.service_date, lang)}</span>
                </div>
              )}
              {doc.due_date && (
                <div className="flex justify-between">
                  <span className="text-neutral-500">{docType === 'quote' ? t('valid_until', lang) : t('due_date', lang)}</span>
                  <span className={`font-medium ${doc.status === 'overdue' ? 'text-red-600' : ''}`}>
                    {formatDate(doc.due_date, lang)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Line items */}
          <div className="mb-6 rounded-xl overflow-hidden border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500 uppercase tracking-wide">{t('description', lang)}</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-neutral-500 uppercase tracking-wide w-16">{t('qty', lang)}</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-neutral-500 uppercase tracking-wide w-28">{t('rate', lang)}</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-neutral-500 uppercase tracking-wide w-28">{t('amount', lang)}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => {
                  const lt = item.line_type ?? 'item'

                  if (lt === 'separator') {
                    return <tr key={i}><td colSpan={4} className="border-t border-neutral-100 py-0" /></tr>
                  }
                  if (lt === 'page_break') return null
                  if (lt === 'heading') {
                    return (
                      <tr key={i} className="border-b border-neutral-100">
                        <td colSpan={4} className="px-4 py-2.5 font-semibold text-neutral-900">{item.description}</td>
                      </tr>
                    )
                  }
                  if (lt === 'text') {
                    return (
                      <tr key={i} className="border-b border-neutral-100">
                        <td colSpan={4} className="px-4 py-2 text-neutral-500 text-xs">{item.description}</td>
                      </tr>
                    )
                  }
                  if (lt === 'subtotal') {
                    let sum = 0
                    for (let j = i - 1; j >= 0; j--) {
                      if ((items[j].line_type ?? 'item') === 'subtotal') break
                      if ((items[j].line_type ?? 'item') === 'item' && items[j].quantity != null && items[j].unit_price != null) {
                        sum += items[j].quantity! * items[j].unit_price!
                      }
                    }
                    return (
                      <tr key={i} className="border-b border-neutral-100 bg-neutral-50">
                        <td colSpan={3} className="px-4 py-2 text-right text-xs text-neutral-400 uppercase tracking-wide font-medium">Subtotal</td>
                        <td className="px-4 py-2 text-right font-semibold text-neutral-900">{fmt(sum)}</td>
                      </tr>
                    )
                  }

                  if (item.quantity == null || item.unit_price == null) return null
                  return (
                    <tr key={i} className="border-b border-neutral-100 hover:bg-neutral-50 transition-colors">
                      <td className="px-4 py-3">
                        <div className="text-neutral-900">{item.description}</div>
                        {item.service_date && (
                          <div className="text-xs text-neutral-400 mt-0.5">{formatDate(item.service_date, lang)}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-neutral-600">{item.quantity}</td>
                      <td className="px-4 py-3 text-right text-neutral-600">{fmt(item.unit_price)}</td>
                      <td className="px-4 py-3 text-right font-medium text-neutral-900">{fmt(item.quantity * item.unit_price)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="flex justify-end mb-8">
            <div className="w-64 space-y-1.5 text-sm">
              <div className="flex justify-between text-neutral-500">
                <span>{t('subtotal', lang)}</span>
                <span>{fmt(totals.subtotal)}</span>
              </div>
              {totals.discount_amount > 0 && (
                <div className="flex justify-between text-neutral-500">
                  <span>{t('discount', lang)}{doc.discount_type === 'percent' && doc.discount_value ? ` (${doc.discount_value}%)` : ''}</span>
                  <span>−{fmt(totals.discount_amount)}</span>
                </div>
              )}
              {doc.tax_treatment === 'at_vat' && totals.vat_groups.map(g => (
                <div key={g.rate} className="flex justify-between text-neutral-500">
                  <span>{t('vat', lang)} {g.rate}%</span>
                  <span>{fmt(g.amount)}</span>
                </div>
              ))}
              <div className="border-t border-neutral-200 pt-1.5 flex justify-between font-semibold text-neutral-900 text-base">
                <span>{t('total', lang)}</span>
                <span>{fmt(totals.total)}</span>
              </div>
              {totals.total_paid > 0 && (
                <>
                  <div className="flex justify-between text-neutral-500">
                    <span>{t('paid_amount', lang)}</span>
                    <span className="text-green-600">−{fmt(totals.total_paid)}</span>
                  </div>
                  <div className="flex justify-between font-semibold text-neutral-900">
                    <span>{t('balance_due', lang)}</span>
                    <span className={totals.balance_due > 0 ? 'text-red-600' : 'text-green-600'}>{fmt(totals.balance_due)}</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Notes */}
          {doc.notes && (
            <div className="mb-6 rounded-xl border border-neutral-200 bg-white px-4 py-3">
              <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wide mb-1.5">{t('notes', lang)}</div>
              <p className="text-sm text-neutral-600 whitespace-pre-line">{doc.notes}</p>
            </div>
          )}

          {/* Payment info */}
          {showPaymentInfo && (
            <div className="mb-6 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
              <div className="text-xs font-semibold text-blue-400 uppercase tracking-wide mb-1.5">{t('payment_info', lang)}</div>
              <div className="text-sm text-blue-900 space-y-0.5">
                <div className="font-medium">{settings.company_name}</div>
                {settings.bank_name && <div>{settings.bank_name}</div>}
                <div>IBAN: <span className="font-mono">{settings.iban}</span></div>
                <div>BIC: <span className="font-mono">{settings.bic}</span></div>
                <div className="text-xs text-blue-600 mt-1">{doc.number}</div>
              </div>
            </div>
          )}

          {/* Download PDF */}
          <div className="flex justify-end">
            <a
              href={`/portal/${token}/pdf`}
              download
              className="inline-flex items-center gap-2 bg-neutral-900 text-white text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-neutral-700 transition-colors"
            >
              <Download size={15} />
              {t('download_pdf', lang)}
            </a>
          </div>

        </div>
  )
}
