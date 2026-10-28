import { Font } from '@react-pdf/renderer'

export const PDF_FONT_FAMILY = 'Noto Sans'

const FILES = [
  { file: 'NotoSans-Regular.ttf', fontWeight: 400, fontStyle: 'normal' },
  { file: 'NotoSans-Bold.ttf', fontWeight: 700, fontStyle: 'normal' },
  { file: 'NotoSans-Italic.ttf', fontWeight: 400, fontStyle: 'italic' },
] as const

let registeredFrom: string | null = null

// Noto Sans (SIL OFL, public/fonts/OFL.txt) covers Latin Extended, the minus sign and the euro
// sign, all of which the built-in Helvetica (WinAnsi) drops. The browser fetches the files from
// /fonts; the server reads them from disk (render.ts), because a serverless function cannot
// fetch its own public folder.
export function registerPdfFonts(dir: string) {
  if (registeredFrom === dir) return
  registeredFrom = dir
  Font.register({
    family: PDF_FONT_FAMILY,
    fonts: FILES.map(f => ({ src: `${dir}/${f.file}`, fontWeight: f.fontWeight, fontStyle: f.fontStyle })),
  })
}
