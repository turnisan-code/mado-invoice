import type { CatalogueItem, Language } from '@/types'

type LineSource = Pick<CatalogueItem, 'name_de' | 'name_en' | 'description_de' | 'description_en'>

// The text a picked catalogue item puts on a document line: the name in the document language,
// then its long description. A missing translation falls back to the other. The builder's line
// field is a single-line input, which silently drops line breaks, so the description is joined
// onto one line until that field can hold several.
export function catalogueLineText(item: LineSource, lang: Language): string {
  const name = (lang === 'de' ? item.name_de || item.name_en : item.name_en || item.name_de) || ''
  const description = (lang === 'de' ? item.description_de || item.description_en : item.description_en || item.description_de)
    ?.replace(/\s*\n\s*/g, ' ').trim()
  return description ? `${name} – ${description}` : name
}
