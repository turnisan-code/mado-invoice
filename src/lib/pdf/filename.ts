// The file name of a document's PDF: its number, without the characters a file name or a
// Content-Disposition header cannot carry. Pure, so the browser shows the name the server attaches.
export function pdfFilename(number: string): string {
  return `${number.replace(/["\\/\r\n]+/g, '_')}.pdf`
}
