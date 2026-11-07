import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { SupabaseClient } from '@supabase/supabase-js'
import { documentLanguage, documentT } from '@/lib/document-labels'
import { fetchStorno } from '@/lib/utils/document-reference'
import { formatDate } from '@/lib/utils/document'
import type { Language } from '@/types'

// The cancelled stamp. A numbered document that is cancelled (an invoice its Storno cancelled, a
// cancelled quote) is shown and sent with a red stamp across its first page: the PDF opened or
// downloaded in Mado, the portal's PDF, an emailed PDF and the one a Peppol e-invoice embeds. It is
// laid over the frozen copy each time that copy goes out; the stored file itself stays exactly as
// issued, and so do the copies that archive it (the Drive copy, the Bookamat attachment, the ZIP
// export), which never pass through here. Runs on the server and, for the editor's preview, in the
// browser. The font is one of the PDF standard fonts, so no font file is read.

export type StornoRef = { number: string; date: string }
export type CancelStamp = { title: string; detail: string | null }

// In the document's language: 'STORNIERT' / 'CANCELLED', and the Storno that cancelled an invoice
// with its date as the PDF prints dates.
export function cancelStamp(lang: Language, storno: StornoRef | null): CancelStamp {
  const t = documentT(lang)
  return {
    title: t('pdfPortal.cancelStamp.title'),
    detail: storno ? t('pdfPortal.cancelStamp.storno', { number: storno.number, date: formatDate(storno.date, lang) }) : null,
  }
}

const RED = rgb(0.8, 0.07, 0.07)
const OPACITY = 0.45
// Rising from left to right, like the builder's draft stamp.
const ANGLE = 30
// The page margin of the issued PDF (IssuerFooter's PDF_PAGE_X), for the line on further pages.
const MARGIN = 52

export async function stampPdf(bytes: Uint8Array, stamp: CancelStamp): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  const pages = pdf.getPages()
  if (!pages.length) throw new Error('The PDF has no pages')
  const font = await pdf.embedFont(StandardFonts.HelveticaBold)
  // The standard fonts cover WinAnsi only; a character outside it (in a number) would fail the save.
  const encodable = new Set(font.getCharacterSet())
  const clean = (text: string) => Array.from(text, c => (encodable.has(c.codePointAt(0) ?? 0) ? c : '?')).join('')
  const title = clean(stamp.title)
  const detail = stamp.detail ? clean(stamp.detail) : null
  drawDiagonal(pages[0], font, title, detail)
  for (const page of pages.slice(1)) drawTopLine(page, font, detail ? `${title} – ${detail}` : title)
  return pdf.save()
}

// Centred a little below the middle of the page, clear of the title block with the number at the
// top; semi-transparent, so nothing under it is hidden.
function drawDiagonal(page: PDFPage, font: PDFFont, title: string, detail: string | null) {
  const box = page.getCropBox()
  const rad = (ANGLE * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)

  const titleSize = Math.min(80, (0.72 * box.width) / font.widthOfTextAtSize(title, 1))
  const titleWidth = font.widthOfTextAtSize(title, titleSize)
  const titleHeight = font.heightAtSize(titleSize, { descender: false })
  const detailSize = detail ? Math.min(titleSize * 0.26, titleWidth / font.widthOfTextAtSize(detail, 1)) : 0
  const detailWidth = detail ? font.widthOfTextAtSize(detail, detailSize) : 0
  const detailHeight = detail ? font.heightAtSize(detailSize, { descender: false }) : 0
  const gap = detail ? titleSize * 0.22 : 0
  const pad = titleSize * 0.22
  const height = titleHeight + gap + detailHeight
  const width = Math.max(titleWidth, detailWidth)

  // (u, v) along and across the stamp, from its centre, to page coordinates.
  const cx = box.x + box.width / 2
  const cy = box.y + box.height * 0.48
  const at = (u: number, v: number) => ({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos })
  const rotate = degrees(ANGLE)

  page.drawText(title, { ...at(-titleWidth / 2, height / 2 - titleHeight), size: titleSize, font, color: RED, opacity: OPACITY, rotate })
  if (detail) page.drawText(detail, { ...at(-detailWidth / 2, -height / 2), size: detailSize, font, color: RED, opacity: OPACITY, rotate })
  page.drawRectangle({
    ...at(-width / 2 - pad, -height / 2 - pad),
    width: width + 2 * pad,
    height: height + 2 * pad,
    rotate,
    borderColor: RED,
    borderWidth: Math.max(2, titleSize / 22),
    borderOpacity: OPACITY,
  })
}

// Top right, level with the running header the further pages carry on the left.
function drawTopLine(page: PDFPage, font: PDFFont, text: string) {
  const box = page.getCropBox()
  const size = Math.min(8, (box.width - 2 * MARGIN) / font.widthOfTextAtSize(text, 1))
  const width = font.widthOfTextAtSize(text, size)
  page.drawText(text, { x: box.x + box.width - MARGIN - width, y: box.y + box.height - 31, size, font, color: RED, opacity: 0.85 })
}

type StampedDoc = { id: string; type: string; number: string | null; status: string; language?: string | null }

// The frozen copy as it is shown or sent: stamped when the numbered document is cancelled,
// otherwise the very bytes given. Never fails: should the Storno not be found the stamp names none,
// and should stamping fail the copy goes out unstamped (logged), so a download or an email never
// stops here.
export async function withCancelStamp(supabase: SupabaseClient, doc: StampedDoc, bytes: Uint8Array): Promise<Uint8Array> {
  if (!doc.number || doc.status !== 'cancelled') return bytes
  let storno: StornoRef | null = null
  if (doc.type === 'invoice') {
    try {
      storno = await fetchStorno(supabase, doc.id)
    } catch (err) {
      console.error(`[pdf/stamp] ${doc.number}: Storno not found, stamped without it:`, err)
    }
  }
  try {
    return await stampPdf(bytes, cancelStamp(documentLanguage(doc.language), storno))
  } catch (err) {
    console.error(`[pdf/stamp] ${doc.number}: sent without the cancelled stamp:`, err)
    return bytes
  }
}
