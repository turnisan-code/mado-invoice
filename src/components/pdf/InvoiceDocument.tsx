import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer'
import { formatMoney, formatDate } from '@/lib/utils/document'
import type { Settings, Client, DocumentType, Language, TaxTreatment, Currency, Unit, VatRate, LineType, DocumentTotals } from '@/types'

const s = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 9, color: '#1a1a1a', paddingHorizontal: 52, paddingTop: 48, paddingBottom: 100, backgroundColor: '#ffffff', display: 'flex', flexDirection: 'column' },

  topRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 40 },
  logo: { width: 130, height: 52, objectFit: 'contain', objectPositionX: 0 },
  logoFallback: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: '#1a1a1a', maxWidth: 160 },
  docTitle: { fontSize: 22, fontFamily: 'Helvetica-Bold', marginBottom: 5 },
  metaLine: { fontSize: 9, color: '#4b4b4b', marginBottom: 2 },
  qrBelowTotals: { width: 72, height: 72, marginTop: 14, alignSelf: 'flex-end' },

  billedSection: { marginBottom: 32 },
  billedLabel: { fontSize: 8, fontFamily: 'Helvetica-Bold', marginBottom: 5 },
  billedText: { fontSize: 9, color: '#4b4b4b', lineHeight: 1.6 },

  tableHeader: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#1a1a1a', borderBottomWidth: 1, borderBottomColor: '#1a1a1a', paddingVertical: 6, marginBottom: 0 },
  tableHeaderText: { fontSize: 8, fontFamily: 'Helvetica-Bold' },
  tableRow: { flexDirection: 'row', paddingVertical: 7, borderBottomWidth: 0.5, borderBottomColor: '#d4d4d4' },
  colDesc: { flex: 1 },
  colDescDate: { fontSize: 7.5, color: '#9b9b9b', marginTop: 2 },
  colQty: { width: 40, textAlign: 'right' },
  colRate: { width: 88, textAlign: 'right' },
  colAmount: { width: 72, textAlign: 'right' },

  headingRow: { paddingVertical: 8, paddingTop: 12 },
  headingText: { fontFamily: 'Helvetica-Bold', fontSize: 9.5 },
  textRow: { paddingVertical: 4 },
  textRowText: { fontSize: 8.5, color: '#4b4b4b' },
  separatorRow: { borderTopWidth: 0.5, borderTopColor: '#d4d4d4', marginVertical: 6 },
  subtotalRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingVertical: 5, borderTopWidth: 0.5, borderTopColor: '#d4d4d4', marginTop: 2 },
  subtotalLabel: { fontSize: 7.5, color: '#9b9b9b', marginRight: 8, textTransform: 'uppercase' },
  subtotalValue: { width: 72, textAlign: 'right', fontFamily: 'Helvetica-Bold', fontSize: 8.5 },

  bottomDivider: { borderTopWidth: 1, borderTopColor: '#1a1a1a', marginTop: 28, marginBottom: 18 },
  bottomRow: { flexDirection: 'row', justifyContent: 'space-between' },
  dueDateLabel: { fontSize: 8, color: '#6b6b6b', marginBottom: 3 },
  dueDateValue: { fontSize: 9, fontFamily: 'Helvetica-Bold' },

  totalsBlock: { width: 210 },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  totalsLabel: { color: '#6b6b6b' },
  totalsDivider: { borderTopWidth: 0.5, borderTopColor: '#d4d4d4', marginVertical: 4 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  totalLabel: { fontFamily: 'Helvetica-Bold', fontSize: 10 },
  totalValue: { fontFamily: 'Helvetica-Bold', fontSize: 10 },

  taxNote: { marginTop: 16, fontSize: 8, color: '#6b6b6b', fontStyle: 'italic' },
  notes: { marginTop: 10, fontSize: 8.5, color: '#4b4b4b', lineHeight: 1.6 },
  footerNote: { marginTop: 16, fontSize: 8.5, color: '#4b4b4b', lineHeight: 1.6 },

  footer: { position: 'absolute', bottom: 36, left: 52, right: 52, borderTopWidth: 0.5, borderTopColor: '#d4d4d4', paddingTop: 12, flexDirection: 'row', justifyContent: 'space-between' },
  footerTitle: { fontSize: 10, fontFamily: 'Helvetica-Bold', marginBottom: 5 },
  footerText: { fontSize: 8, color: '#4b4b4b', lineHeight: 1.7 },
  footerPage: { fontSize: 8, color: '#9b9b9b' },
})

const LABELS: Record<string, Record<'de' | 'en', string>> = {
  invoice:       { de: 'Rechnung',             en: 'Invoice' },
  quote:         { de: 'Angebot',              en: 'Quote' },
  credit_note:   { de: 'Gutschrift',           en: 'Credit Note' },
  bill_to:       { de: 'Rechnungsempfänger',   en: 'Billed to' },
  invoice_no:    { de: 'Rechnungsnummer:',     en: 'Invoice No.' },
  quote_no:      { de: 'Angebotsnummer:',      en: 'Quote No.' },
  date_label:    { de: 'Datum:',               en: 'Date:' },
  due_label:     { de: 'Fälligkeitsdatum:',    en: 'Due Date:' },
  valid_label:   { de: 'Gültig bis:',          en: 'Valid Until:' },
  service_label: { de: 'Leistungsdatum:',      en: 'Service Date:' },
  description:   { de: 'Beschreibung',         en: 'Description' },
  qty:           { de: 'Menge',                en: 'Qty' },
  rate:          { de: 'Preis',                en: 'Rate' },
  amount:        { de: 'Betrag',               en: 'Amount' },
  subtotal:      { de: 'Nettobetrag',          en: 'Sub-Total' },
  discount:      { de: 'Rabatt',               en: 'Discount' },
  grand_total:   { de: 'Gesamtbetrag',         en: 'Total' },
  contact:       { de: 'Kontakt',              en: 'Contact' },
  payment:       { de: 'Zahlungsinformationen', en: 'Payment Info' },
  uid:           { de: 'UID-Nr.',              en: 'VAT Reg.' },
}

function L(key: string, lang: 'de' | 'en'): string {
  return LABELS[key]?.[lang] ?? key
}

function replaceVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

interface DocItem {
  line_type?: LineType
  description: string
  service_date: string | null
  quantity: number | null
  unit: Unit | null
  unit_price: number | null
  vat_rate: VatRate | null
}

interface DocData {
  number: string
  date: string
  service_date: string | null
  due_date: string | null
  type: DocumentType
  language: Language
  currency: Currency
  tax_treatment: TaxTreatment
  notes: string | null
  tax_note: string | null
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  items: DocItem[]
  totals: DocumentTotals
}

interface Props {
  settings: Settings
  client: Client
  document: DocData
  qrCodeDataUri?: string | null
}

function calcSectionSubtotal(items: DocItem[], upToIdx: number): number {
  let sum = 0
  for (let i = upToIdx - 1; i >= 0; i--) {
    const item = items[i]
    if ((item.line_type ?? 'item') === 'subtotal') break
    if ((item.line_type ?? 'item') === 'item' && item.quantity != null && item.unit_price != null) {
      sum += item.quantity * item.unit_price
    }
  }
  return sum
}

export default function InvoiceDocument({ settings, client, document: doc, qrCodeDataUri }: Props) {
  const lang = doc.language as 'de' | 'en'
  const fmt = (n: number) => formatMoney(n, doc.currency)
  const noLabel = doc.type === 'quote' ? L('quote_no', lang) : L('invoice_no', lang)

  const footerVars: Record<string, string> = {
    invoice_number: doc.number,
    date: doc.date,
    due_date: doc.due_date ?? '',
    client: client.company ?? client.name,
    subtotal: fmt(doc.totals.subtotal),
    vat: fmt(doc.totals.total_vat),
    total: fmt(doc.totals.total),
    balance_due: fmt(doc.totals.balance_due),
  }

  const rawFooter = doc.type === 'quote'
    ? (lang === 'de' ? settings.quote_footer_de : settings.quote_footer_en)
    : (lang === 'de' ? settings.invoice_footer_de : settings.invoice_footer_en)
  const footerText = rawFooter ? replaceVars(rawFooter, footerVars) : null

  return (
    <Document>
      <Page size="A4" style={s.page}>

        {/* Top row */}
        <View style={s.topRow}>
          <View>
            {settings.logo_url
              ? <Image src={settings.logo_url} style={s.logo} />
              : <Text style={s.logoFallback}>{settings.company_name}</Text>
            }
          </View>
          <View>
            <Text style={s.docTitle}>{L(doc.type, lang)}</Text>
            <Text style={s.metaLine}>{noLabel} {doc.number}</Text>
            <Text style={s.metaLine}>{L('date_label', lang)} {formatDate(doc.date, lang)}</Text>
            {!!doc.service_date && (
              <Text style={s.metaLine}>{L('service_label', lang)} {formatDate(doc.service_date, lang)}</Text>
            )}
          </View>
        </View>

        {/* Billed to */}
        <View style={s.billedSection}>
          <Text style={s.billedLabel}>{L('bill_to', lang)}</Text>
          <Text style={s.billedText}>
            {client.company ? `${client.company}\n` : ''}{client.name}{'\n'}
            {client.address_line1}{'\n'}
            {client.address_line2 ? `${client.address_line2}\n` : ''}
            {client.zip} {client.city}{'\n'}
            {client.country}
            {client.uid_number ? `\n${L('uid', lang)}: ${client.uid_number}` : ''}
          </Text>
        </View>

        {/* Table header */}
        <View style={s.tableHeader}>
          <Text style={[s.tableHeaderText, s.colDesc]}>{L('description', lang)}</Text>
          <Text style={[s.tableHeaderText, s.colQty]}>{L('qty', lang)}</Text>
          <Text style={[s.tableHeaderText, s.colRate]}>{L('rate', lang)}</Text>
          <Text style={[s.tableHeaderText, s.colAmount]}>{L('amount', lang)}</Text>
        </View>

        {/* Line items */}
        {doc.items.map((item, i) => {
          const lt = item.line_type ?? 'item'

          if (lt === 'page_break') return <View key={i} break />
          if (lt === 'separator') return <View key={i} style={s.separatorRow} />

          if (lt === 'heading') {
            return (
              <View key={i} style={s.headingRow}>
                <Text style={s.headingText}>{item.description}</Text>
              </View>
            )
          }

          if (lt === 'text') {
            return (
              <View key={i} style={s.textRow}>
                <Text style={s.textRowText}>{item.description}</Text>
              </View>
            )
          }

          if (lt === 'subtotal') {
            return (
              <View key={i} style={s.subtotalRow}>
                <Text style={s.subtotalLabel}>Subtotal</Text>
                <Text style={s.subtotalValue}>{fmt(calcSectionSubtotal(doc.items, i))}</Text>
              </View>
            )
          }

          if (item.quantity == null || item.unit_price == null || item.unit == null) return false
          return (
            <View key={i} style={s.tableRow}>
              <View style={s.colDesc}>
                <Text>{item.description}</Text>
                {!!item.service_date && (
                  <Text style={s.colDescDate}>{formatDate(item.service_date, lang)}</Text>
                )}
              </View>
              <Text style={s.colQty}>{item.quantity}</Text>
              <Text style={s.colRate}>{fmt(item.unit_price)}/{item.unit}</Text>
              <Text style={s.colAmount}>{fmt(item.quantity * item.unit_price)}</Text>
            </View>
          )
        })}

        {/* Divider + due date + totals — wrap={false} keeps this whole block on one page */}
        <View wrap={false}>
        <View style={s.bottomDivider} />
        <View style={s.bottomRow}>
          <View>
            {!!doc.due_date && (
              <View>
                <Text style={s.dueDateLabel}>{doc.type === 'quote' ? L('valid_label', lang) : L('due_label', lang)}</Text>
                <Text style={s.dueDateValue}>{formatDate(doc.due_date, lang)}</Text>
              </View>
            )}
          </View>
          <View style={s.totalsBlock}>
            <View style={s.totalsRow}>
              <Text style={s.totalsLabel}>{L('subtotal', lang)}</Text>
              <Text>{fmt(doc.totals.subtotal)}</Text>
            </View>
            {doc.totals.discount_amount > 0 && (
              <View style={s.totalsRow}>
                <Text style={s.totalsLabel}>
                  {L('discount', lang)}{doc.discount_type === 'percent' && doc.discount_value ? ` (${doc.discount_value}%)` : ''}
                </Text>
                <Text>−{fmt(doc.totals.discount_amount)}</Text>
              </View>
            )}
            {doc.tax_treatment === 'at_vat' && doc.totals.vat_groups.map(g => (
              <View key={g.rate} style={s.totalsRow}>
                <Text style={s.totalsLabel}>USt. {g.rate}%</Text>
                <Text>{fmt(g.amount)}</Text>
              </View>
            ))}
            <View style={s.totalsDivider} />
            <View style={s.totalRow}>
              <Text style={s.totalLabel}>{L('grand_total', lang)}</Text>
              <Text style={s.totalValue}>{fmt(doc.totals.total)}</Text>
            </View>
            {doc.totals.total_paid > 0 && (
              <View style={s.totalsRow}>
                <Text style={s.totalsLabel}>{lang === 'de' ? 'Offen' : 'Balance due'}</Text>
                <Text style={{ fontFamily: 'Helvetica-Bold' }}>{fmt(doc.totals.balance_due)}</Text>
              </View>
            )}
            {!!qrCodeDataUri && (
              <Image src={qrCodeDataUri} style={s.qrBelowTotals} />
            )}
          </View>
        </View>

        </View>{/* end wrap={false} bottom block */}

        {!!doc.tax_note && <Text style={s.taxNote}>{doc.tax_note}</Text>}
        {!!doc.notes && <Text style={s.notes}>{doc.notes}</Text>}
        {!!footerText && <Text style={s.footerNote}>{footerText}</Text>}

        {/* Footer */}
        <View style={s.footer} fixed>
          <View>
            <Text style={s.footerTitle}>{L('contact', lang)}</Text>
            <Text style={s.footerText}>
              {[settings.phone, settings.email, `${settings.address_line1}, ${settings.zip} ${settings.city}`].filter(Boolean).join('\n')}
            </Text>
          </View>
          <View>
            <Text style={s.footerTitle}>{L('payment', lang)}</Text>
            <Text style={s.footerText}>
              {settings.company_name}{'\n'}
              {settings.bank_name ? `${settings.bank_name}\n` : ''}
              {'IBAN: '}{settings.iban}{'\n'}
              {'BIC: '}{settings.bic}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end', justifyContent: 'flex-end' }}>
            <Text style={s.footerPage} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
          </View>
        </View>

      </Page>
    </Document>
  )
}
