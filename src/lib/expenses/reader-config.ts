// Whether Mado can read PDFs with Claude (PR 9b, decision D3): without ANTHROPIC_API_KEY a
// receipt search lists what it finds and proves nothing by a read. Light on purpose: the
// „Kontoauszug“ page asks it without loading the SDK.
export const pdfReaderConfigured = (): boolean => !!process.env.ANTHROPIC_API_KEY?.trim()
