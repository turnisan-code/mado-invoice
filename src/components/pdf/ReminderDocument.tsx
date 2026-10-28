import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer'
import { makeT, n } from '@/lib/i18n'
import { templateDate, templateMoney, templatePercent, senderName, formatIban } from '@/lib/templates'
import { countryName } from '@/lib/utils/country'
import type { ReminderFigures } from '@/lib/utils/reminder-templates'
import type { SecretSettingsKey } from '@/lib/public-settings'
import type { Client, Language, Settings } from '@/types'

// Same page frame as InvoiceDocument, so a Mahnung reads as part of the same correspondence.
const s = StyleSheet.create({
  // The bottom padding keeps text clear of the fixed footer (up to five contact lines).
  page: { fontFamily: 'Helvetica', fontSize: 9, color: '#1a1a1a', paddingHorizontal: 52, paddingTop: 44, paddingBottom: 150, backgroundColor: '#ffffff' },

  topRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 },
  logo: { width: 130, height: 52, objectFit: 'contain', objectPositionX: 0 },
  logoFallback: { fontSize: 18, fontFamily: 'Helvetica-Bold', maxWidth: 160 },
  docTitle: { fontSize: 22, fontFamily: 'Helvetica-Bold', marginBottom: 5 },
  metaLine: { fontSize: 9, color: '#4b4b4b', marginBottom: 2 },

  billedSection: { marginBottom: 22 },
  billedLabel: { fontSize: 8, fontFamily: 'Helvetica-Bold', marginBottom: 5 },
  billedText: { fontSize: 9, color: '#4b4b4b', lineHeight: 1.6 },

  subject: { fontSize: 10, fontFamily: 'Helvetica-Bold', marginBottom: 12 },
  paragraph: { fontSize: 9, lineHeight: 1.5, marginBottom: 8 },

  table: { marginTop: 4, marginBottom: 4, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 0.5, borderBottomColor: '#d4d4d4' },
  rowLabel: { flex: 1, paddingRight: 12 },
  rowSub: { fontSize: 7.5, color: '#9b9b9b', marginTop: 2 },
  rowValue: { width: 96, textAlign: 'right' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
  totalLabel: { fontFamily: 'Helvetica-Bold', fontSize: 10 },
  totalValue: { width: 96, textAlign: 'right', fontFamily: 'Helvetica-Bold', fontSize: 10 },

  payRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 12, marginBottom: 4 },
  payText: { flex: 1, paddingRight: 16, fontSize: 9, lineHeight: 1.5 },
  qrBox: { alignItems: 'center', width: 96 },
  qr: { width: 64, height: 64 },
  qrCaption: { fontSize: 6.5, color: '#9b9b9b', textAlign: 'center', marginTop: 3 },

  regards: { marginTop: 12, fontSize: 9 },
  signature: { marginTop: 4, fontSize: 9, fontFamily: 'Helvetica-Bold' },

  footer: { position: 'absolute', bottom: 36, left: 52, right: 52, borderTopWidth: 0.5, borderTopColor: '#d4d4d4', paddingTop: 12, flexDirection: 'row', justifyContent: 'space-between' },
  footerTitle: { fontSize: 10, fontFamily: 'Helvetica-Bold', marginBottom: 5 },
  footerText: { fontSize: 8, color: '#4b4b4b', lineHeight: 1.7 },
  footerPage: { fontSize: 8, color: '#9b9b9b' },
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
  figures: ReminderFigures
  qrCodeDataUri?: string | null
}

export default function ReminderDocument({ settings, client, invoice, totals, figures, qrCodeDataUri }: Props) {
  const lang = invoice.language
  const t = makeT(lang)
  const money = (amount: number) => templateMoney(amount, lang, invoice.currency)
  const date = (value: string | null) => templateDate(value, lang)
  const days = (count: number) => n(count, t('dunning.pdf.dayOne', { days: count }), t('dunning.pdf.dayOther', { days: count }))
  const intro = figures.level <= 1 ? t('dunning.pdf.intro1') : figures.level === 2 ? t('dunning.pdf.intro2') : t('dunning.pdf.intro3')
  const sender = senderName(settings)

  return (
    <Document title={`${figures.title} ${invoice.number}`} author={sender} language={lang}>
      <Page size="A4" style={s.page}>
        <View style={s.topRow}>
          <View>
            {settings.logo_url
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
          <Text style={s.billedLabel}>{t('dunning.pdf.recipient')}</Text>
          <Text style={s.billedText}>
            {client.company ? `${client.company}\n` : ''}{client.name ? `${client.name}\n` : ''}
            {client.address_line1}{'\n'}
            {client.address_line2 ? `${client.address_line2}\n` : ''}
            {client.zip} {client.city}{'\n'}
            {countryName(client.country, lang)}
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
          {totals.total_paid > 0 && (
            <View style={s.row}>
              <Text style={s.rowLabel}>{t('dunning.pdf.paid')}</Text>
              <Text style={s.rowValue}>-{money(totals.total_paid)}</Text>
            </View>
          )}
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

        <View style={s.footer} fixed>
          <View>
            <Text style={s.footerTitle}>{t('dunning.pdf.contact')}</Text>
            <Text style={s.footerText}>
              {[
                settings.company_name,
                `${settings.address_line1}, ${settings.zip} ${settings.city}`,
                settings.phone,
                settings.email,
                settings.uid_number ? `${t('dunning.pdf.uid')} ${settings.uid_number}` : null,
              ].filter(Boolean).join('\n')}
            </Text>
          </View>
          <View>
            <Text style={s.footerTitle}>{t('dunning.pdf.payment')}</Text>
            <Text style={s.footerText}>
              {[
                settings.company_name || settings.owner_name,
                settings.bank_name,
                settings.iban ? `IBAN: ${formatIban(settings.iban)}` : null,
                settings.bic ? `BIC: ${settings.bic}` : null,
              ].filter(Boolean).join('\n')}
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
