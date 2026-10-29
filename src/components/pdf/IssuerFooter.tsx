import { StyleSheet, Text, View } from '@react-pdf/renderer'
import type { TFn } from '@/lib/i18n'
import { issuerBlocks, type IssuerSettings } from '@/lib/document-labels'
import type { Language } from '@/types'

// The issuer footer every printed document carries (invoice, quote, credit note, Mahnung): address
// with the owner, contact with website and UID, and the bank details where money is asked for.

export const PDF_PAGE_X = 52

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

export type FooterColumn = { title: string; lines: string[] }

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

export function issuerFooterColumns(settings: IssuerSettings, t: TFn, lang: Language, { bank }: { bank: boolean }): FooterColumn[] {
  const issuer = issuerBlocks(settings, t, lang)
  return [
    { title: t('pdfPortal.issuer.address'), lines: issuer.address },
    { title: t('pdfPortal.issuer.contact'), lines: issuer.contact },
    { title: t('pdfPortal.issuer.bank'), lines: bank ? issuer.bank : [] },
  ].filter(c => c.lines.length)
}

// The page's paddingBottom, so the body never runs under the footer.
export function footerPaddingBottom(columns: FooterColumn[]): number {
  const lines = Math.max(1, ...columns.map(c => footerLineCount(c.lines)))
  return FOOTER_BOTTOM + FOOTER_PAD_TOP + FOOTER_LINE + FOOTER_TITLE_GAP + lines * FOOTER_LINE + FOOTER_AIR
}

const s = StyleSheet.create({
  footer: { position: 'absolute', bottom: FOOTER_BOTTOM, left: PDF_PAGE_X, right: PDF_PAGE_X, borderTopWidth: 0.5, borderTopColor: '#d4d4d4', paddingTop: FOOTER_PAD_TOP, flexDirection: 'row' },
  col: { flex: 1, paddingRight: 10 },
  title: { fontSize: FOOTER_FONT, lineHeight: 1.4, fontWeight: 'bold', marginBottom: FOOTER_TITLE_GAP },
  text: { fontSize: FOOTER_FONT, lineHeight: 1.4, color: '#4b4b4b', maxLines: FOOTER_MAX_LINES, textOverflow: 'ellipsis' },
  page: { width: 80, fontSize: FOOTER_FONT, color: '#9b9b9b', textAlign: 'right' },
})

// t in the document's language.
export function IssuerFooter({ columns, t }: { columns: FooterColumn[]; t: TFn }) {
  return (
    <View style={s.footer} fixed>
      {columns.map(col => (
        <View key={col.title} style={s.col}>
          <Text style={s.title}>{col.title}</Text>
          {col.lines.flatMap(footerEntry).map((line, i) => (
            <Text key={i} style={s.text} hyphenationCallback={noHyphenation}>{line}</Text>
          ))}
        </View>
      ))}
      <Text style={s.page} render={({ pageNumber, totalPages }) => t('pdfPortal.page', { page: pageNumber, pages: totalPages })} />
    </View>
  )
}
