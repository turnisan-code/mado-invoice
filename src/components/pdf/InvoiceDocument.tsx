import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer'
import { clampPercent, formatDate, lineAmount, orderItems, paymentTermsSentence, sectionSummary } from '@/lib/utils/document'
import { clientDisplayName } from '@/lib/utils/clients'
import { countryName } from '@/lib/utils/country'
import {
  docNumberLabel, docTitle, documentKind, documentT, formatPercent, formatQuantity, formatSignedMoney,
  issuerBlocks, recipientLabel, servicePeriod, unitLabel,
} from '@/lib/document-labels'
import type { Settings, Client, DocumentType, Language, TaxTreatment, Currency, Unit, VatRate, LineType, DocumentTotals } from '@/types'
import type { SecretSettingsKey } from '@/lib/public-settings'
import type { DocReference } from '@/lib/utils/document-reference'
import { PDF_FONT_FAMILY, preparePdfFonts, registerPdfFonts } from './fonts'

const inBrowser = typeof window !== 'undefined'
if (inBrowser) registerPdfFonts('/fonts')

const PAGE_X = 52
// The footer is fixed to every page, so the body's bottom padding is derived from its height:
// border gap + title + the longest column, each line at FOOTER_LINE, plus air above it.
const FOOTER_BOTTOM = 26
const FOOTER_PAD_TOP = 8
const FOOTER_FONT = 7.5
const FOOTER_LINE = FOOTER_FONT * 1.4
const FOOTER_TITLE_GAP = 2
const FOOTER_AIR = 18
// A long bank name or street takes a second line (then an ellipsis). A column is about 127pt on
// invoices, which holds a little over 30 characters; counting from 30 errs towards more room.
const FOOTER_MAX_LINES = 2
const FOOTER_LINE_CHARS = 30

function bodyPaddingBottom(footerLines: number) {
  return FOOTER_BOTTOM + FOOTER_PAD_TOP + FOOTER_LINE + FOOTER_TITLE_GAP + footerLines * FOOTER_LINE + FOOTER_AIR
}

// Footer entries wrap at spaces and are never hyphenated: an inserted hyphen would change an
// e-mail address or IBAN. A long entry without spaces (e-mail, web address) breaks after @ or /
// or before a dot instead.
function footerEntry(line: string): string[] {
  if (line.length <= FOOTER_LINE_CHARS || /\s/.test(line)) return [line]
  const head = line.slice(0, FOOTER_LINE_CHARS)
  const cut = Math.max(head.lastIndexOf('@') + 1, head.lastIndexOf('/') + 1, head.lastIndexOf('.'))
  return cut > 0 ? [line.slice(0, cut), line.slice(cut)] : [line]
}

function footerLineCount(lines: string[]) {
  return lines.flatMap(footerEntry).reduce((sum, line) => sum + Math.min(FOOTER_MAX_LINES, Math.ceil(line.length / FOOTER_LINE_CHARS)), 0)
}

const noHyphenation = (word: string) => [word]

// An item row moves to the next page as a whole when it fits on one; a row taller than a page has
// to wrap, or react-pdf draws it past the page bottom. A page holds about 50 lines, the narrowest
// description column about 45 characters of ordinary text per line, and 20 estimated lines still
// fit when wide letters make the real count twice that.
const KEEP_ROW_LINES = 20
const ROW_LINE_CHARS = 45

function keepRowTogether(description: string) {
  const lines = description.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / ROW_LINE_CHARS)), 0)
  return lines <= KEEP_ROW_LINES
}

const GREY = '#6b6b6b'
const LIGHT = '#9b9b9b'
const RULE = '#d4d4d4'

const s = StyleSheet.create({
  page: { fontFamily: PDF_FONT_FAMILY, fontSize: 9, color: '#1a1a1a', paddingHorizontal: PAGE_X, paddingTop: 48, backgroundColor: '#ffffff' },
  runningHeader: { position: 'absolute', top: 24, left: PAGE_X, right: PAGE_X, fontSize: 7.5, color: LIGHT },
  draftStamp: { position: 'absolute', top: 340, left: 0, right: 0, textAlign: 'center', fontSize: 96, fontWeight: 'bold', color: '#efefef', transform: 'rotate(-30deg)' },

  topRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 32 },
  logo: { width: 130, height: 52, objectFit: 'contain', objectPositionX: 0 },
  logoFallback: { fontSize: 18, fontWeight: 'bold', maxWidth: 220 },
  titleBlock: { maxWidth: 260 },
  docTitle: { fontSize: 22, fontWeight: 'bold', lineHeight: 1.2, marginBottom: 6 },
  metaLine: { fontSize: 9, color: '#4b4b4b' },

  senderLine: { fontSize: 6.5, color: LIGHT, marginBottom: 6, alignSelf: 'flex-start', borderBottomWidth: 0.5, borderBottomColor: RULE, paddingBottom: 1 },
  recipientSection: { marginBottom: 28 },
  recipientLabel: { fontSize: 8, fontWeight: 'bold', marginBottom: 4 },
  recipientText: { fontSize: 9, color: '#4b4b4b', lineHeight: 1.5 },

  tableHeader: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#1a1a1a', borderBottomWidth: 1, borderBottomColor: '#1a1a1a', paddingVertical: 5 },
  tableHeaderText: { fontSize: 8, fontWeight: 'bold' },
  tableRow: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: RULE },
  colDesc: { flex: 1, paddingRight: 8 },
  colDescSub: { fontSize: 7.5, color: LIGHT, marginTop: 1 },
  colQty: { width: 64, textAlign: 'right' },
  colPrice: { width: 76, textAlign: 'right' },
  colVat: { width: 38, textAlign: 'right' },
  colAmount: { width: 76, textAlign: 'right' },

  headingRow: { paddingTop: 11, paddingBottom: 5 },
  headingText: { fontWeight: 'bold', fontSize: 9.5 },
  textRow: { paddingVertical: 4 },
  textRowText: { fontSize: 8.5, color: '#4b4b4b' },
  separatorRow: { borderTopWidth: 0.5, borderTopColor: RULE, marginVertical: 6 },
  subtotalRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: RULE },
  subtotalLabel: { fontSize: 7.5, color: LIGHT, marginRight: 8, textTransform: 'uppercase' },
  subtotalValue: { width: 76, textAlign: 'right', fontWeight: 'bold', fontSize: 8.5 },
  struck: { color: LIGHT, textDecoration: 'line-through' },

  bottomDivider: { borderTopWidth: 1, borderTopColor: '#1a1a1a', marginTop: 24, marginBottom: 14 },
  bottomRow: { flexDirection: 'row', justifyContent: 'space-between' },
  dueLabel: { fontSize: 8, color: GREY, marginBottom: 2 },
  dueValue: { fontSize: 9, fontWeight: 'bold' },
  qr: { width: 84, height: 84, marginTop: 12 },
  qrCaption: { fontSize: 7, color: GREY, width: 160, marginTop: 2 },

  totalsBlock: { width: 230 },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  totalsLabel: { color: GREY },
  totalsDivider: { borderTopWidth: 0.5, borderTopColor: RULE, marginVertical: 4 },
  totalText: { fontWeight: 'bold', fontSize: 10 },

  paymentTerms: { marginTop: 14, fontSize: 8.5, color: '#4b4b4b' },
  taxNote: { marginTop: 14, fontSize: 8, color: GREY, fontStyle: 'italic' },
  notes: { marginTop: 10, fontSize: 8.5, color: '#4b4b4b', lineHeight: 1.5 },

  footer: { position: 'absolute', bottom: FOOTER_BOTTOM, left: PAGE_X, right: PAGE_X, borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: FOOTER_PAD_TOP, flexDirection: 'row' },
  footerCol: { flex: 1, paddingRight: 10 },
  footerTitle: { fontSize: FOOTER_FONT, lineHeight: 1.4, fontWeight: 'bold', marginBottom: FOOTER_TITLE_GAP },
  footerText: { fontSize: FOOTER_FONT, lineHeight: 1.4, color: '#4b4b4b', maxLines: FOOTER_MAX_LINES, textOverflow: 'ellipsis' },
  footerPage: { width: 80, fontSize: FOOTER_FONT, color: LIGHT, textAlign: 'right' },
})

interface DocItem {
  line_type?: LineType
  sort_order?: number | null
  description: string
  service_date: string | null
  // Per-line end date; optional because older rows and callers do not carry it.
  service_date_end?: string | null
  quantity: number | null
  unit: Unit | null
  unit_price: number | null
  vat_rate: VatRate | null
  discount_type?: 'percent' | 'fixed' | null
  discount_value?: number | null
}

interface DocData {
  number: string
  date: string
  service_date: string | null
  service_date_end?: string | null
  due_date: string | null
  type: DocumentType
  language: Language
  currency: Currency
  tax_treatment: TaxTreatment
  notes: string | null
  tax_note: string | null
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  skonto_percent?: number | null
  skonto_days?: number | null
  items: DocItem[]
  totals: DocumentTotals
  reference?: DocReference | null
}

interface Props {
  settings: Omit<Settings, SecretSettingsKey>
  client: Client
  document: DocData
  qrCodeDataUri?: string | null
}

function replaceVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

export default function InvoiceDocument({ settings, client, document: doc, qrCodeDataUri }: Props) {
  // The builder renders with pdf().toBlob(), which loads the fonts after this runs; the server
  // awaits preparePdfFonts() in render.ts. A font that fails to load fails the render itself.
  if (inBrowser) preparePdfFonts().catch(() => {})
  const lang: Language = doc.language === 'en' ? 'en' : 'de'
  const t = documentT(lang)
  const refKind = doc.reference ? (doc.reference.kind ?? 'storno') : null
  const kind = documentKind(doc.type, refKind === 'storno')
  const title = docTitle(t, kind)
  // The builder previews an unnumbered document as 'DRAFT'.
  const draft = !doc.number || doc.number === 'DRAFT'
  const number = draft ? t('pdfPortal.draft') : doc.number
  // Credit notes are stored with positive amounts and print as credits.
  const sign = doc.type === 'credit_note' ? -1 : 1
  const money = (n: number) => formatSignedMoney(sign * n, doc.currency)
  const pct = (n: number) => formatPercent(t, n, lang)

  const items = orderItems(doc.items)
  const vatApplies = doc.tax_treatment === 'at_vat'
  const lineRates = new Set(items.filter(i => (i.line_type ?? 'item') === 'item' && i.vat_rate != null).map(i => i.vat_rate))
  const showVatColumn = vatApplies && lineRates.size > 1

  const issuer = issuerBlocks(settings, t, lang)
  const bankLines = doc.type === 'invoice' ? issuer.bank : []
  const footerColumns = [
    { title: t('pdfPortal.issuer.address'), lines: issuer.address },
    { title: t('pdfPortal.issuer.contact'), lines: issuer.contact },
    { title: t('pdfPortal.issuer.bank'), lines: bankLines },
  ].filter(c => c.lines.length)
  const paddingBottom = bodyPaddingBottom(Math.max(1, ...footerColumns.map(c => footerLineCount(c.lines))))

  const senderLine = [settings.company_name || settings.owner_name, settings.address_line1, [settings.zip, settings.city].filter(Boolean).join(' ')]
    .map(v => v?.trim()).filter(Boolean).join(' · ')
  const docPeriod = servicePeriod(doc.service_date, doc.service_date_end, lang)
  const dueLabel = doc.type === 'quote' ? t('pdfPortal.validUntil') : doc.type === 'invoice' ? t('pdfPortal.dueDate') : null

  const footerVars: Record<string, string> = {
    invoice_number: number,
    date: formatDate(doc.date, lang),
    due_date: doc.due_date ? formatDate(doc.due_date, lang) : '',
    client: clientDisplayName(client),
    subtotal: money(doc.totals.subtotal),
    vat: money(doc.totals.total_vat),
    total: money(doc.totals.total),
    balance_due: money(doc.totals.balance_due),
  }
  const rawFooter = doc.type === 'quote'
    ? (lang === 'de' ? settings.quote_footer_de : settings.quote_footer_en)
    : doc.type === 'credit_note'
    ? (lang === 'de' ? settings.credit_note_footer_de : settings.credit_note_footer_en)
    : (lang === 'de' ? settings.invoice_footer_de : settings.invoice_footer_en)
  const footerText = rawFooter ? replaceVars(rawFooter, footerVars) : null
  const paymentTerms = paymentTermsSentence(doc, doc.totals.total, lang)

  return (
    <Document title={`${title} ${number}`} author={settings.company_name || settings.owner_name} language={lang}>
      <Page size="A4" style={[s.page, { paddingBottom }]}>
        {draft && <Text fixed style={s.draftStamp}>{t('pdfPortal.draft').toUpperCase()}</Text>}
        <Text fixed style={s.runningHeader} render={({ pageNumber }) => (pageNumber > 1 ? `${title} ${number}` : '')} />

        <View style={s.topRow}>
          <View>
            {settings.logo_url
              // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt
              ? <Image src={settings.logo_url} style={s.logo} />
              : <Text style={s.logoFallback}>{settings.company_name || settings.owner_name}</Text>}
          </View>
          <View style={s.titleBlock}>
            <Text style={s.docTitle}>{title}</Text>
            <Text style={s.metaLine}>{docNumberLabel(t, kind)}: {number}</Text>
            <Text style={s.metaLine}>{t('pdfPortal.date')}: {formatDate(doc.date, lang)}</Text>
            {docPeriod && (
              <Text style={s.metaLine}>
                {docPeriod.isPeriod ? t('pdfPortal.servicePeriod') : t('pdfPortal.serviceDate')}: {docPeriod.text}
              </Text>
            )}
            {doc.reference && (
              <Text style={s.metaLine}>
                {t(refKind === 'storno' ? 'pdfPortal.stornoOf' : 'pdfPortal.correctionOf', { number: doc.reference.number, date: formatDate(doc.reference.date, lang) })}
              </Text>
            )}
          </View>
        </View>

        <View style={s.recipientSection}>
          {!!senderLine && <Text style={s.senderLine}>{senderLine}</Text>}
          <Text style={s.recipientLabel}>{recipientLabel(t, kind)}</Text>
          <Text style={s.recipientText}>
            {[
              client.company,
              client.name,
              client.address_line1,
              client.address_line2,
              [client.zip, client.city].filter(Boolean).join(' '),
              countryName(client.country, lang),
              client.uid_number ? `${t('pdfPortal.issuer.uid')} ${client.uid_number}` : null,
            ].map(v => v?.trim()).filter(Boolean).join('\n')}
          </Text>
        </View>

        <View>
          <View style={s.tableHeader} fixed>
            <Text style={[s.tableHeaderText, s.colDesc]}>{t('pdfPortal.columns.description')}</Text>
            <Text style={[s.tableHeaderText, s.colQty]}>{t('pdfPortal.columns.quantity')}</Text>
            <Text style={[s.tableHeaderText, s.colPrice]}>{t('pdfPortal.columns.unitPrice')}</Text>
            {showVatColumn && <Text style={[s.tableHeaderText, s.colVat]}>{t('pdfPortal.columns.vat')}</Text>}
            <Text style={[s.tableHeaderText, s.colAmount]}>{t('pdfPortal.columns.amount')}</Text>
          </View>

          {items.map((item, i) => {
            const lt = item.line_type ?? 'item'

            if (lt === 'page_break') return <View key={i} break />
            if (lt === 'separator') return <View key={i} style={s.separatorRow} />

            if (lt === 'heading') {
              return (
                <View key={i} style={s.headingRow} wrap={false} minPresenceAhead={36}>
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
              const sec = sectionSummary(items, i)
              return (
                <View key={i} wrap={false}>
                  <View style={s.subtotalRow}>
                    <Text style={s.subtotalLabel}>{t('pdfPortal.section.subtotal')}</Text>
                    <Text style={[s.subtotalValue, ...(sec.discount > 0 ? [s.struck] : [])]}>{money(sec.gross)}</Text>
                  </View>
                  {sec.discount > 0 && (
                    <>
                      <View style={s.subtotalRow}>
                        <Text style={s.subtotalLabel}>
                          {sec.percent != null ? t('pdfPortal.section.discountPercent', { percent: pct(sec.percent) }) : t('pdfPortal.section.discount')}
                        </Text>
                        <Text style={s.subtotalValue}>{money(-sec.discount)}</Text>
                      </View>
                      <View style={s.subtotalRow}>
                        <Text style={[s.subtotalLabel, { fontWeight: 'bold' }]}>{t('pdfPortal.section.net')}</Text>
                        <Text style={s.subtotalValue}>{money(sec.net)}</Text>
                      </View>
                    </>
                  )}
                </View>
              )
            }

            if (item.quantity == null || item.unit_price == null) return null
            const period = servicePeriod(item.service_date, item.service_date_end, lang)
            // The line's own discount, already taken off its amount.
            const lineOff = lineAmount({ quantity: item.quantity, unit_price: item.unit_price }) - lineAmount(item)
            return (
              <View key={i} style={s.tableRow} wrap={!keepRowTogether(item.description)}>
                <View style={s.colDesc}>
                  <Text>{item.description}</Text>
                  {period && <Text style={s.colDescSub}>{period.text}</Text>}
                  {lineOff > 0 && (
                    <Text style={s.colDescSub}>
                      {item.discount_type === 'percent'
                        ? t('editor.doc.lineDiscountPercent', { percent: pct(clampPercent(item.discount_value)), amount: money(-lineOff) })
                        : t('editor.doc.lineDiscount', { amount: money(-lineOff) })}
                    </Text>
                  )}
                </View>
                <Text style={s.colQty}>
                  {formatQuantity(item.quantity, lang)}{item.unit ? ` ${unitLabel(t, item.unit, item.quantity)}` : ''}
                </Text>
                <Text style={s.colPrice}>{formatSignedMoney(item.unit_price, doc.currency)}</Text>
                {showVatColumn && <Text style={s.colVat}>{item.vat_rate != null ? pct(item.vat_rate) : ''}</Text>}
                <Text style={s.colAmount}>{money(lineAmount(item))}</Text>
              </View>
            )
          })}
        </View>

        <View wrap={false}>
          <View style={s.bottomDivider} />
          <View style={s.bottomRow}>
            <View>
              {!!doc.due_date && dueLabel && (
                <>
                  <Text style={s.dueLabel}>{dueLabel}</Text>
                  <Text style={s.dueValue}>{formatDate(doc.due_date, lang)}</Text>
                </>
              )}
              {!!qrCodeDataUri && (
                <>
                  {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt */}
                  <Image src={qrCodeDataUri} style={s.qr} />
                  <Text style={s.qrCaption}>{t('pdfPortal.payment.qrCaption')}</Text>
                </>
              )}
            </View>
            <View style={s.totalsBlock}>
              <View style={s.totalsRow}>
                <Text style={s.totalsLabel}>{t('pdfPortal.totals.net')}</Text>
                <Text>{money(doc.totals.subtotal)}</Text>
              </View>
              {doc.totals.discount_amount > 0 && (
                <View style={s.totalsRow}>
                  <Text style={s.totalsLabel}>
                    {doc.discount_type === 'percent' && doc.discount_value
                      ? t('pdfPortal.totals.discountPercent', { percent: pct(clampPercent(doc.discount_value)) })
                      : t('pdfPortal.totals.discount')}
                  </Text>
                  <Text>{money(-doc.totals.discount_amount)}</Text>
                </View>
              )}
              {/* § 11 UStG: the net amount (Entgelt) per rate, then the tax on it */}
              {vatApplies && doc.totals.vat_groups.map(g => (
                <View key={g.rate}>
                  <View style={s.totalsRow}>
                    <Text style={s.totalsLabel}>{t('pdfPortal.totals.netAtRate', { rate: pct(g.rate) })}</Text>
                    <Text>{money(g.base)}</Text>
                  </View>
                  <View style={s.totalsRow}>
                    <Text style={s.totalsLabel}>{t('pdfPortal.totals.vatAtRate', { rate: pct(g.rate) })}</Text>
                    <Text>{money(g.amount)}</Text>
                  </View>
                </View>
              ))}
              <View style={s.totalsDivider} />
              <View style={s.totalsRow}>
                <Text style={s.totalText}>{doc.type === 'credit_note' ? t('pdfPortal.totals.creditTotal') : t('pdfPortal.totals.total')}</Text>
                <Text style={s.totalText}>{money(doc.totals.total)}</Text>
              </View>
              {doc.type === 'invoice' && doc.totals.total_paid > 0 && (
                <>
                  <View style={s.totalsRow}>
                    <Text style={s.totalsLabel}>{t('pdfPortal.totals.paid')}</Text>
                    <Text>{money(-doc.totals.total_paid)}</Text>
                  </View>
                  <View style={s.totalsRow}>
                    <Text style={[s.totalsLabel, { fontWeight: 'bold' }]}>{t('pdfPortal.totals.balanceDue')}</Text>
                    <Text style={{ fontWeight: 'bold' }}>{money(doc.totals.balance_due)}</Text>
                  </View>
                </>
              )}
            </View>
          </View>
          {!!paymentTerms && <Text style={s.paymentTerms}>{paymentTerms}</Text>}
        </View>

        {!!doc.tax_note && <Text style={s.taxNote}>{doc.tax_note}</Text>}
        {!!doc.notes && <Text style={s.notes}>{doc.notes}</Text>}
        {!!footerText && <Text style={s.notes}>{footerText}</Text>}

        <View style={s.footer} fixed>
          {footerColumns.map(col => (
            <View key={col.title} style={s.footerCol}>
              <Text style={s.footerTitle}>{col.title}</Text>
              {col.lines.flatMap(footerEntry).map((line, i) => (
                <Text key={i} style={s.footerText} hyphenationCallback={noHyphenation}>{line}</Text>
              ))}
            </View>
          ))}
          <Text style={s.footerPage} render={({ pageNumber, totalPages }) => t('pdfPortal.page', { page: pageNumber, pages: totalPages })} />
        </View>
      </Page>
    </Document>
  )
}
