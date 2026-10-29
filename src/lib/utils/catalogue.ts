import type { CatalogueItem, ClientRate, Language, LineType } from '@/types'

type LineSource = Pick<CatalogueItem, 'name_de' | 'name_en' | 'description_de' | 'description_en'>

// An item's name in `lang`; a missing translation falls back to the other.
export function catalogueName(item: Pick<CatalogueItem, 'name_de' | 'name_en'>, lang: Language): string {
  return (lang === 'de' ? item.name_de || item.name_en : item.name_en || item.name_de) || ''
}

// The text a picked catalogue item puts on a document line: the name in the document language,
// then its long description on the lines below. A missing translation falls back to the other.
export function catalogueLineText(item: LineSource, lang: Language): string {
  const name = catalogueName(item, lang)
  const description = (lang === 'de' ? item.description_de || item.description_en : item.description_en || item.description_de)?.trim()
  return description ? `${name}\n${description}` : name
}

// A client's rate card: catalogue item id → the client's own price for it.
export type RateMap = Record<string, number>

export function rateMap(rates: Pick<ClientRate, 'catalogue_item_id' | 'price'>[]): RateMap {
  return Object.fromEntries(rates.map(r => [r.catalogue_item_id, Number(r.price)]))
}

// The price a catalogue item gets on a line for a client: its rate card price, else the default.
export function cataloguePrice(item: Pick<CatalogueItem, 'id' | 'default_price'>, rates: RateMap): number {
  return rates[item.id] ?? Number(item.default_price)
}

const samePrice = (a: number | undefined, b: number | undefined) =>
  a !== undefined && b !== undefined && Math.abs(a - b) < 0.005

// Whether a line still carries the client's own price for its catalogue item.
export function hasClientRate(line: { catalogue_item_id: string | null; unit_price: number }, rates: RateMap): boolean {
  return !!line.catalogue_item_id && samePrice(rates[line.catalogue_item_id], line.unit_price)
}

export interface PriceChange { id: string; description: string; from: number; to: number }

type PricedLine = { id: string; line_type: LineType; description: string; unit_price: number; catalogue_item_id: string | null }

// What switching a document from one client's rates to another's changes: catalogue lines still at
// the catalogue price or the previous client's rate move to the new client's price. A price typed
// in by hand stays.
export function repriceLines(lines: PricedLine[], catalogue: Pick<CatalogueItem, 'id' | 'default_price'>[], from: RateMap, to: RateMap): PriceChange[] {
  const byId = new Map(catalogue.map(i => [i.id, i]))
  const changes: PriceChange[] = []
  for (const l of lines) {
    const item = l.line_type === 'item' && l.catalogue_item_id ? byId.get(l.catalogue_item_id) : undefined
    if (!item) continue
    const target = cataloguePrice(item, to)
    if (samePrice(l.unit_price, target)) continue
    if (samePrice(l.unit_price, Number(item.default_price)) || samePrice(l.unit_price, from[item.id])) {
      changes.push({ id: l.id, description: l.description.split('\n')[0], from: l.unit_price, to: target })
    }
  }
  return changes
}
