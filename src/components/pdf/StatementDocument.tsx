import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer'
import { makeT } from '@/lib/i18n'
import { templateDate, templateMoney, senderName, formatIban } from '@/lib/templates'
import { countryName } from '@/lib/utils/country'
import { roundCents } from '@/lib/utils/document'
import { epcBeneficiary } from '@/lib/utils/epc-qr'
import type { StatementRow, StatementSum } from '@/lib/statement'
import type { SecretSettingsKey } from '@/lib/public-settings'
import type { Client, Language, Settings } from '@/types'
import { PDF_FONT_FAMILY } from './fonts'

// Same page frame as the invoice and the Mahnung, so a statement reads as part of the same
// correspondence.
const s = StyleSheet.create({
  // The bottom padding keeps text clear of the fixed footer (up to five contact lines).
  page: { fontFamily: PDF_FONT_FAMILY, fontSize: 9, color: '#1a1a1a', paddingHorizontal: 52, paddingTop: 44, paddingBottom: 150, backgroundColor: '#ffffff' },

  topRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 },
  logo: { width: 130, height: 52, objectFit: 'contain', objectPositionX: 0 },
  logoFallback: { fontSize: 18, fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', maxWidth: 160 },
  docTitle: { fontSize: 22, fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', marginBottom: 5 },
  metaLine: { fontSize: 9, color: '#4b4b4b', marginBottom: 2 },

  billedSection: { marginBottom: 22 },
  billedLabel: { fontSize: 8, fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', marginBottom: 5 },
  billedText: { fontSize: 9, color: '#4b4b4b', lineHeight: 1.6 },

  paragraph: { fontSize: 9, lineHeight: 1.5, marginBottom: 8 },

  table: { marginTop: 4, marginBottom: 4 },
  headRow: { flexDirection: 'row', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  headText: { fontSize: 7.5, fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', color: '#4b4b4b' },
  row: { flexDirection: 'row', paddingVertical: 5, borderBottomWidth: 0.5, borderBottomColor: '#d4d4d4' },
  cell: { fontSize: 8.5 },
  sub: { fontSize: 7, color: '#9b9b9b', marginTop: 1 },
  colDate: { width: 56 },
  colDoc: { flex: 1, paddingRight: 8 },
  colDue: { width: 56 },
  colAmount: { width: 72, paddingLeft: 6, textAlign: 'right' },
  colSettled: { width: 86, paddingLeft: 6, textAlign: 'right' },
  colOpen: { width: 72, paddingLeft: 6, textAlign: 'right' },
  sumRow: { flexDirection: 'row', paddingVertical: 6, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
  sumText: { fontSize: 8.5, fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold' },
  sumLabel: { flex: 1 },
  empty: { fontSize: 9, color: '#4b4b4b', paddingVertical: 10 },

  balanceRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10, marginBottom: 12 },
  balanceBox: { borderTopWidth: 1, borderTopColor: '#1a1a1a', borderBottomWidth: 1, borderBottomColor: '#1a1a1a', paddingVertical: 6, width: 218, flexDirection: 'row', justifyContent: 'space-between' },
  balanceLabel: { fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', fontSize: 10 },
  balanceValue: { fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', fontSize: 10, textAlign: 'right' },

  regards: { marginTop: 12, fontSize: 9 },
  signature: { marginTop: 4, fontSize: 9, fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold' },

  footer: { position: 'absolute', bottom: 36, left: 52, right: 52, borderTopWidth: 0.5, borderTopColor: '#d4d4d4', paddingTop: 12, flexDirection: 'row', justifyContent: 'space-between' },
  footerTitle: { fontSize: 10, fontFamily: PDF_FONT_FAMILY, fontWeight: 'bold', marginBottom: 5 },
  footerText: { fontSize: 8, color: '#4b4b4b', lineHeight: 1.7 },
  footerPage: { fontSize: 8, color: '#9b9b9b' },
})

interface Props {
  settings: Omit<Settings, SecretSettingsKey>
  client: Client
  language: Language
  from: string
  to: string
  issuedOn: string
  openOnly: boolean
  rows: StatementRow[]
  sums: StatementSum[]
}

export default function StatementDocument({ settings, client, language: lang, from, to, issuedOn, openOnly, rows, sums }: Props) {
  const t = makeT(lang)
  const date = (value: string | null) => templateDate(value, lang)
  // Credits print with a real minus sign, never as "-0,00".
  const money = (amount: number, currency: string) => {
    const value = roundCents(amount)
    return value < 0 ? `−${templateMoney(-value, lang, currency)}` : templateMoney(value, lang, currency)
  }
  const sender = senderName(settings)
  const title = t('projects.statement.pdf.title')
  const several = sums.length > 1
  const main = sums[0]

  let payText: string | null = null
  if (main && main.open > 0.005) payText = t('projects.statement.pdf.pay', { amount: money(main.open, main.currency) })
  else if (main && main.open < -0.005) payText = t('projects.statement.pdf.credit', { amount: money(-main.open, main.currency) })
  else if (rows.length) payText = t('projects.statement.pdf.settledAll')

  return (
    <Document title={`${title} ${client.client_number ?? ''}`.trim()} author={sender} language={lang}>
      <Page size="A4" style={s.page}>
        <View style={s.topRow}>
          <View>
            {settings.logo_url
              // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt
              ? <Image src={settings.logo_url} style={s.logo} />
              : <Text style={s.logoFallback}>{sender}</Text>}
          </View>
          <View>
            <Text style={s.docTitle}>{title}</Text>
            <Text style={s.metaLine}>{t('projects.statement.pdf.date')} {date(issuedOn)}</Text>
            <Text style={s.metaLine}>{t('projects.statement.pdf.period')} {t('projects.statement.pdf.periodValue', { from: date(from), to: date(to) })}</Text>
            {!!client.client_number && <Text style={s.metaLine}>{t('projects.statement.pdf.clientNo')} {client.client_number}</Text>}
          </View>
        </View>

        <View style={s.billedSection}>
          <Text style={s.billedLabel}>{t('projects.statement.pdf.recipient')}</Text>
          <Text style={s.billedText}>
            {client.company ? `${client.company}\n` : ''}{client.name ? `${client.name}\n` : ''}
            {client.address_line1}{'\n'}
            {client.address_line2 ? `${client.address_line2}\n` : ''}
            {client.zip} {client.city}{'\n'}
            {countryName(client.country, lang)}
          </Text>
        </View>

        <Text style={s.paragraph}>{t('projects.statement.pdf.salutation')}</Text>
        <Text style={s.paragraph}>
          {t(openOnly ? 'projects.statement.pdf.introOpen' : 'projects.statement.pdf.intro', { from: date(from), to: date(to), date: date(issuedOn) })}
        </Text>

        <View style={s.table}>
          <View style={s.headRow}>
            <Text style={[s.headText, s.colDate]}>{t('projects.statement.pdf.columns.date')}</Text>
            <Text style={[s.headText, s.colDoc]}>{t('projects.statement.pdf.columns.document')}</Text>
            <Text style={[s.headText, s.colDue]}>{t('projects.statement.pdf.columns.due')}</Text>
            <Text style={[s.headText, s.colAmount]}>{t('projects.statement.pdf.columns.amount')}</Text>
            <Text style={[s.headText, s.colSettled]}>{t('projects.statement.pdf.columns.settled')}</Text>
            <Text style={[s.headText, s.colOpen]}>{t('projects.statement.pdf.columns.open')}</Text>
          </View>
          {rows.length === 0 && (
            <Text style={s.empty}>{t(openOnly ? 'projects.statement.pdf.noneOpen' : 'projects.statement.pdf.none')}</Text>
          )}
          {rows.map(r => (
            <View key={r.id} style={s.row} wrap={false}>
              <Text style={[s.cell, s.colDate]}>{date(r.date)}</Text>
              <View style={s.colDoc}>
                <Text style={s.cell}>{t(`projects.statement.pdf.${r.kind}`, { number: r.number })}</Text>
                {r.cancelled && <Text style={s.sub}>{t('projects.statement.pdf.cancelled')}</Text>}
              </View>
              <Text style={[s.cell, s.colDue]}>{r.cancelled ? '' : date(r.due_date)}</Text>
              <Text style={[s.cell, s.colAmount]}>{money(r.total, r.currency)}</Text>
              <Text style={[s.cell, s.colSettled]}>{money(r.settled, r.currency)}</Text>
              <Text style={[s.cell, s.colOpen]}>{money(r.open, r.currency)}</Text>
            </View>
          ))}
          {sums.map(sum => (
            <View key={sum.currency} style={s.sumRow} wrap={false}>
              <Text style={[s.sumText, s.sumLabel]}>
                {several ? t('projects.statement.pdf.totalCurrency', { currency: sum.currency }) : t('projects.statement.pdf.total')}
              </Text>
              <Text style={[s.sumText, s.colAmount]}>{money(sum.total, sum.currency)}</Text>
              <Text style={[s.sumText, s.colSettled]}>{money(sum.settled, sum.currency)}</Text>
              <Text style={[s.sumText, s.colOpen]}>{money(sum.open, sum.currency)}</Text>
            </View>
          ))}
        </View>

        {sums.map(sum => (
          <View key={sum.currency} style={s.balanceRow} wrap={false}>
            <View style={s.balanceBox}>
              <Text style={s.balanceLabel}>{sum.open < -0.005 ? t('projects.statement.pdf.balanceCredit') : t('projects.statement.pdf.balanceDue')}</Text>
              <Text style={s.balanceValue}>{money(Math.abs(sum.open), sum.currency)}</Text>
            </View>
          </View>
        ))}

        {payText && <Text style={s.paragraph}>{payText}</Text>}
        <Text style={s.paragraph}>{t('projects.statement.pdf.closing')}</Text>

        <View wrap={false}>
          <Text style={s.regards}>{t('projects.statement.pdf.regards')}</Text>
          <Text style={s.signature}>{settings.owner_name || sender}</Text>
        </View>

        <View style={s.footer} fixed>
          <View>
            <Text style={s.footerTitle}>{t('projects.statement.pdf.contact')}</Text>
            <Text style={s.footerText}>
              {[
                settings.company_name,
                `${settings.address_line1}, ${settings.zip} ${settings.city}`,
                settings.phone,
                settings.email,
                settings.uid_number ? `${t('projects.statement.pdf.uid')} ${settings.uid_number}` : null,
              ].filter(Boolean).join('\n')}
            </Text>
          </View>
          <View>
            <Text style={s.footerTitle}>{t('projects.statement.pdf.payment')}</Text>
            <Text style={s.footerText}>
              {[
                epcBeneficiary(settings),
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
