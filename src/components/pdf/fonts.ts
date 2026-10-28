import { Font } from '@react-pdf/renderer'

export const PDF_FONT_FAMILY = 'Noto Sans'

const FILES = [
  { file: 'NotoSans-Regular.ttf', fontWeight: 400, fontStyle: 'normal' },
  { file: 'NotoSans-Bold.ttf', fontWeight: 700, fontStyle: 'normal' },
  { file: 'NotoSans-Italic.ttf', fontWeight: 400, fontStyle: 'italic' },
] as const

// The part of a loaded fontkit font this file touches (@react-pdf/font types it loosely).
type LoadedFont = {
  characterSet: number[]
  glyphForCodePoint(codePoint: number): unknown
  layout(text: string, features?: unknown, ...rest: unknown[]): unknown
}

const NO_LIGATURES = { liga: false, clig: false }

let registeredFrom: string | null = null
let prepared: Promise<void> | null = null

// Noto Sans (SIL OFL, public/fonts/OFL.txt) covers Latin Extended, the minus sign and the euro
// sign, all of which the built-in Helvetica (WinAnsi) drops. The browser fetches the files from
// /fonts; the server reads them from disk (render.ts), because a serverless function cannot
// fetch its own public folder.
export function registerPdfFonts(dir: string) {
  if (registeredFrom === dir) return
  registeredFrom = dir
  prepared = null
  Font.register({
    family: PDF_FONT_FAMILY,
    fonts: FILES.map(f => ({ src: `${dir}/${f.file}`, fontWeight: f.fontWeight, fontStyle: f.fontStyle })),
  })
}

// Two fixes to the loaded fonts, applied once per process (browser tab) and per face as soon as it
// has loaded, ahead of the renderer's own wait for it:
// - fontkit keeps one glyph object per glyph for the whole process, with the characters of
//   whoever asked first. Embedding an accented capital (Ö = O + ¨) asks for the plain O with none,
//   and every later document printed its O as nothing ("Owner" became "wner"). Asking for every
//   character once, before the first document is embedded, gives each glyph its character.
// - That also gives the ligature glyphs their own characters (ﬁ), so an f+i that layout joined
//   counted as one character, and every line break after it landed a character late ("offen-" /
//   "en"). Laying out without ligatures keeps one glyph per character.
export function preparePdfFonts(): Promise<void> {
  prepared ??= Promise.all(FILES.map(async f => {
    const descriptor = { fontFamily: PDF_FONT_FAMILY, fontWeight: f.fontWeight, fontStyle: f.fontStyle }
    await Font.load(descriptor)
    const font = Font.getFont(descriptor).data as unknown as LoadedFont | null
    if (!font) return
    for (const codePoint of font.characterSet) font.glyphForCodePoint(codePoint)
    const layout = font.layout.bind(font)
    font.layout = (text, features, ...rest) => layout(text, features ?? NO_LIGATURES, ...rest)
  })).then(
    () => undefined,
    err => {
      prepared = null
      throw err
    },
  )
  return prepared
}
