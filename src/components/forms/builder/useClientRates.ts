'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { rateMap, repriceLines, type PriceChange, type RateMap } from '@/lib/utils/catalogue'
import { useT } from '@/lib/i18n/client'
import type { CatalogueItem } from '@/types'
import type { LineItem } from './model'

const NO_RATES: RateMap = {}

export interface RepriceOffer { clientName: string; changes: PriceChange[] }

// The selected client's rate card, loaded once per client, and the offer to move the catalogue
// lines to another client's prices when the client changes.
export function useClientRates(clientId: string, catalogue: CatalogueItem[], setLines: (fn: (lines: LineItem[]) => LineItem[]) => void) {
  const { t } = useT()
  const [loaded, setLoaded] = useState<Record<string, RateMap>>({})
  const cache = useRef<Record<string, Promise<RateMap | null>>>({})
  // The client the last change went to: an offer computed for an earlier pick is dropped.
  const target = useRef<string | null>(null)
  const [offer, setOffer] = useState<RepriceOffer | null>(null)

  // null = not loaded. Picking stays at catalogue prices, and the toast offers another try.
  const load = useCallback(function load(id: string): Promise<RateMap | null> {
    cache.current[id] ??= Promise.resolve(createClient().from('client_rates').select('catalogue_item_id, price').eq('client_id', id))
      .then(({ data, error }) => {
        if (error) throw new Error(error.message)
        const map = rateMap(data ?? [])
        setLoaded(l => ({ ...l, [id]: map }))
        return map
      })
      .catch(err => {
        delete cache.current[id]
        console.error('[rates] client rates not loaded:', err)
        toast.error(t('rates.loadFailed'), { action: { label: t('common.tryAgain'), onClick: () => void load(id) } })
        return null
      })
    return cache.current[id]
  }, [t])

  useEffect(() => { if (clientId) void load(clientId) }, [clientId, load])

  async function clientChanged(fromId: string, toId: string, clientName: string, lines: LineItem[]) {
    target.current = toId
    if (!toId || toId === fromId || !lines.some(l => l.catalogue_item_id)) return
    const [from, to] = await Promise.all([fromId ? load(fromId) : NO_RATES, load(toId)])
    // Without the new client's rates every line would look like it should go back to the catalogue price.
    if (target.current !== toId || !to) return
    const changes = repriceLines(lines, catalogue, from ?? NO_RATES, to)
    if (changes.length) setOffer({ clientName, changes })
  }

  // Only lines still at the price the offer was made for move; one edited since stays.
  function applyOffer() {
    if (!offer) return
    const byId = new Map(offer.changes.map(c => [c.id, c]))
    setLines(ls => ls.map(l => {
      const c = byId.get(l.id)
      return c && l.unit_price === c.from ? { ...l, unit_price: c.to } : l
    }))
    setOffer(null)
    toast.success(t('rates.repriced'))
  }

  return { rates: (clientId && loaded[clientId]) || NO_RATES, offer, clientChanged, applyOffer, dismissOffer: () => setOffer(null) }
}
