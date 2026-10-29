import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer'
import { makeT, n } from '@/lib/i18n'
import { templateDate, templateMoney, templatePercent, senderName } from '@/lib/templates'
import { countryName } from '@/lib/utils/country'
import { formatSignedMoney } from '@/lib/document-labels'
import { paymentLineLabel } from '@/lib/payment-summary'
import type { ReminderFigures } from '@/lib/utils/reminder-templates'
import type { SecretSettingsKey } from '@/lib/public-settings'
import type { Client, Language, PaymentSummaryLine, Settings } from '@/types'
import { PDF_FONT_FAMILY } from './fonts'
import { IssuerFooter, PDF_PAGE_X, footerPaddingBottom, issuerFooterColumns } from './IssuerFooter'

// Same page frame and footer as InvoiceDocument, so a Mahnung reads as part of the same correspondence.
const s = StyleSheet.create({
  page: { fontFamily: PDF_FONT_FAMILY, fontSize: 9, color: '#1a1a1a', paddingHorizontal: PDF_PAGE_X, paddingTop: 44, backgroundColor: '#ffffff' },

  topRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 },
  logo: { width: 130, height: 52, objectFit: 'contain', objectPositionX: 0 },
  logoFallback: { fontSize: 18, fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', maxWidth: 160 },
  docTitle: { fontSize: 22, fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', marginBottom: 5 },
  metaLine: { fontSize: 9, color: '#4b4b4b', marginBottom: 2 },

  billedSection: { marginBottom: 22 },
  senderLine: { fontSize: 6.5, color: '#9b9b9b', marginBottom: 6, alignSelf: 'flex-start', borderBottomWidth: 0.5, borderBottomColor: '#d4d4d4', paddingBottom: 1 },
  billedLabel: { fontSize: 8, fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', marginBottom: 5 },
  billedText: { fontSize: 9, color: '#4b4b4b', lineHeight: 1.6 },

  subject: { fontSize: 10, fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', marginBottom: 12 },
  paragraph: { fontSize: 9, lineHeight: 1.5, marginBottom: 8 },

  table: { marginTop: 4, marginBottom: 4, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 0.5, borderBottomColor: '#d4d4d4' },
  rowLabel: { flex: 1, paddingRight: 12 },
  rowSub: { fontSize: 7.5, color: '#9b9b9b', marginTop: 2 },
  rowValue: { width: 96, textAlign: 'right' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
  totalLabel: { fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', fontSize: 10 },
  totalValue: { width: 96, textAlign: 'right', fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', fontSize: 10 },

  payRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 12, marginBottom: 4 },
  payText: { flex: 1, paddingRight: 16, fontSize: 9, lineHeight: 1.5 },
  qrBox: { alignItems: 'center', width: 96 },
  qr: { width: 64, height: 64 },
  qrCaption: { fontSize: 6.5, color: '#9b9b9b', textAlign: 'center', marginTop: 3 },

  regards: { marginTop: 12, fontSize: 9 },
  signature: { marginTop: 4, fontSize: 9, fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold' },
})

export interface ReminderInvoice {
  number: string
  date: string
  due_date: string | null
  currency: string
  language: Language
}

interface Props {
  settings: Omit<Settings, SecretSettingsKey>
  client: Client
  invoice: ReminderInvoice
  totals: { total: number; total_paid: number }
  // What totals.total_paid is made of (summarizePayments).
  payments: PaymentSummaryLine[]
  figures: ReminderFigures
  qrCodeDataUri?: string | null
}

export default function ReminderDocument({ settings, client, invoice, totals, payments, figures, qrCodeDataUri }: Props) {
  const lang = invoice.language
  const t = makeT(lang)
  const money = (amount: number) => templateMoney(amount, lang, invoice.currency)
  const date = (value: string | null) => templateDate(value, lang)
  const days = (count: number) => n(count, t('dunning.pdf.dayOne', { days: count }), t('dunning.pdf.dayOther', { days: count }))
  const intro = figures.level <= 1 ? t('dunning.pdf.intro1') : figures.level === 2 ? t('dunning.pdf.intro2') : t('dunning.pdf.intro3')
  const sender = senderName(settings)
  const footerColumns = issuerFooterColumns(settings, t, lang, { bank: true })
  // DIN 5008: the sender in one line above the recipient's address.
  const senderLine = [sender, settings.address_line1, [settings.zip, settings.city].filter(Boolean).join(' ')]
    .map(v => v?.trim()).filter(Boolean).join(' · ')

  return (
    <Document title={`${figures.title} ${invoice.number}`} author={sender} language={lang}>
      <Page size="A4" style={[s.page, { paddingBottom: footerPaddingBottom(footerColumns) }]}>
        <View style={s.topRow}>
          <View>
            {settings.logo_url
              // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt
              ? <Image src={settings.logo_url} style={s.logo} />
              : <Text style={s.logoFallback}>{sender}</Text>}
          </View>
          <View>
            <Text style={s.docTitle}>{figures.title}</Text>
            <Text style={s.metaLine}>{t('dunning.pdf.date')} {date(figures.issuedOn)}</Text>
            <Text style={s.metaLine}>{t('dunning.pdf.invoiceNo')} {invoice.number}</Text>
            {!!client.client_number && <Text style={s.metaLine}>{t('dunning.pdf.clientNo')} {client.client_number}</Text>}
          </View>
        </View>

        <View style={s.billedSection}>
          {!!senderLine && <Text style={s.senderLine}>{senderLine}</Text>}
          <Text style={s.billedLabel}>{t('dunning.pdf.recipient')}</Text>
          <Text style={s.billedText}>
            {[
              client.company,
              client.name,
              client.address_line1,
              client.address_line2,
              [client.zip, client.city].filter(Boolean).join(' '),
              countryName(client.country, lang),
            ].map(v => v?.trim()).filter(Boolean).join('\n')}
          </Text>
        </View>

        <Text style={s.subject}>{t('dunning.pdf.subject', { title: figures.title, number: invoice.number, date: date(invoice.date) })}</Text>
        <Text style={s.paragraph}>{t('dunning.pdf.salutation')}</Text>
        <Text style={s.paragraph}>{intro}</Text>

        <View style={s.table} wrap={false}>
          <View style={s.row}>
            <View style={s.rowLabel}>
              <Text>{t('dunning.pdf.invoice', { number: invoice.number, date: date(invoice.date) })}</Text>
              {!!invoice.due_date && (
                <Text style={s.rowSub}>{t('dunning.pdf.due', { date: date(invoice.due_date), days: days(figures.daysOverdue) })}</Text>
              )}
            </View>
            <Text style={s.rowValue}>{money(totals.total)}</Text>
          </View>
          {totals.total_paid > 0 && payments.map((line, i) => (
            <View key={i} style={s.row}>
              <Text style={s.rowLabel}>{line.kind === 'paid' ? t('dunning.pdf.paid') : paymentLineLabel(t, line)}</Text>
              <Text style={s.rowValue}>{formatSignedMoney(-line.amount, invoice.currency || 'EUR', lang)}</Text>
            </View>
          ))}
          {(figures.fee > 0 || figures.interest > 0 || totals.total_paid > 0) && (
            <View style={s.row}>
              <Text style={s.rowLabel}>{t('dunning.pdf.open')}</Text>
              <Text style={s.rowValue}>{money(figures.balance)}</Text>
            </View>
          )}
          {figures.fee > 0 && (
            <View style={s.row}>
              <Text style={s.rowLabel}>{t('dunning.pdf.fee')}</Text>
              <Text style={s.rowValue}>{money(figures.fee)}</Text>
            </View>
          )}
          {figures.interest > 0 && (
            <View style={s.row}>
              <Text style={s.rowLabel}>{t('dunning.pdf.interest', {
                rate: t('dunning.terms.perAnnum', { rate: templatePercent(figures.interestRate, lang) }),
                days: days(figures.daysOverdue),
              })}</Text>
              <Text style={s.rowValue}>{money(figures.interest)}</Text>
            </View>
          )}
          <View style={s.totalRow}>
            <Text style={s.totalLabel}>{t('dunning.pdf.totalDue')}</Text>
            <Text style={s.totalValue}>{money(figures.totalDue)}</Text>
          </View>
        </View>

        <View style={s.payRow} wrap={false}>
          <Text style={s.payText}>
            {t('dunning.pdf.pay', { amount: money(figures.totalDue), date: date(figures.newDeadline), reference: invoice.number })}
          </Text>
          {!!qrCodeDataUri && (
            <View style={s.qrBox}>
              {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt */}
              <Image src={qrCodeDataUri} style={s.qr} />
              <Text style={s.qrCaption}>{t('dunning.pdf.scan')}</Text>
            </View>
          )}
        </View>

        {figures.level >= 3 && <Text style={s.paragraph}>{t('dunning.pdf.closingFinal')}</Text>}
        <Text style={s.paragraph}>{t('dunning.pdf.closing')}</Text>

        <View wrap={false}>
          <Text style={s.regards}>{t('dunning.pdf.regards')}</Text>
          <Text style={s.signature}>{settings.owner_name || sender}</Text>
        </View>

        <IssuerFooter columns={footerColumns} t={t} />
      </Page>
    </Document>
  )
}
