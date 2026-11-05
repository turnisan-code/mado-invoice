'use client'

import { useId, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { formatMoney } from '@/lib/utils/document'
import { catalogueName } from '@/lib/utils/catalogue'
import { useT } from '@/lib/i18n/client'
import type { DictKey } from '@/lib/i18n'
import type { CatalogueItem, ClientRate } from '@/types'

// Postgres unique_violation: one rate per client and catalogue item.
const UNIQUE_VIOLATION = '23505'
const SELECT_CLS = 'w-full h-8 border border-neutral-200 dark:border-neutral-700 rounded-lg px-2.5 text-base md:text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400'

// id null = a new rate.
type Draft = { id: string | null; itemId: string; price: number | null; note: string }

// The client's rate card: its own prices for catalogue items, which the editor takes instead of
// the catalogue price when an item is picked for this client.
export default function ClientRates({ clientId, catalogue, initialRates }: {
  clientId: string
  // The whole catalogue in its order, hidden items included (they may still carry a rate).
  catalogue: CatalogueItem[]
  initialRates: ClientRate[]
}) {
  const { t, lang } = useT()
  const uid = useId()
  const [rates, setRates] = useState(initialRates)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const rows = catalogue.flatMap(item => {
    const rate = rates.find(r => r.catalogue_item_id === item.id)
    return rate ? [{ rate, item }] : []
  })
  const available = catalogue.filter(i => i.active && !rates.some(r => r.catalogue_item_id === i.id))
  const categories = Array.from(new Set(available.map(i => i.category).filter((c): c is string => !!c)))
  const draftItem = draft ? catalogue.find(i => i.id === draft.itemId) : undefined
  const perUnit = (price: number, item: CatalogueItem) => `${formatMoney(price)}/${t(`units.${item.unit}` as DictKey)}`

  function open(next: Draft) { setDraft(next); setError(null) }
  function close() { setDraft(null); setError(null) }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!draft || busy) return
    if (!draft.itemId) { setError(t('rates.itemRequired')); return }
    if (draft.price === null) { setError(t('rates.priceRequired')); return }
    setBusy(true)
    const fields = { price: draft.price, note: draft.note.trim() || null }
    const supabase = createClient()
    const { data, error: err } = draft.id
      ? await supabase.from('client_rates').update(fields).eq('id', draft.id).select().single()
      : await supabase.from('client_rates').insert({ client_id: clientId, catalogue_item_id: draft.itemId, ...fields }).select().single()
    setBusy(false)
    if (err) {
      if (err.code === UNIQUE_VIOLATION) setError(t('rates.exists'))
      else toast.error(err.message)
      return
    }
    const saved = { ...data, price: Number(data.price) } as ClientRate
    setRates(rs => (draft.id ? rs.map(r => (r.id === draft.id ? saved : r)) : [...rs, saved]))
    close()
    toast.success(t('rates.saved'))
  }

  async function remove() {
    if (!draft?.id || busy) return
    setBusy(true)
    const { error: err } = await createClient().from('client_rates').delete().eq('id', draft.id)
    setBusy(false)
    if (err) { toast.error(err.message); return }
    setRates(rs => rs.filter(r => r.id !== draft.id))
    close()
    toast.success(t('rates.removed'))
  }

  const form = draft && (
    <form
      onSubmit={save}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close() } }}
      noValidate
      className="space-y-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 p-3"
    >
      {draft.id === null ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-item`}>{t('rates.item')}</Label>
          <select
            id={`${uid}-item`}
            value={draft.itemId}
            autoFocus
            onChange={e => {
              const item = catalogue.find(i => i.id === e.target.value)
              // The price follows the chosen item until it is typed in by hand.
              setDraft(d => {
                if (!d) return d
                const before = catalogue.find(i => i.id === d.itemId)
                const prefilled = d.price === null || (!!before && d.price === Number(before.default_price))
                return { ...d, itemId: e.target.value, price: prefilled ? (item ? Number(item.default_price) : null) : d.price }
              })
            }}
            aria-invalid={(!!error && !draft.itemId) || undefined}
            className={SELECT_CLS}
          >
            <option value="">{t('rates.chooseItem')}</option>
            {categories.map(cat => (
              <optgroup key={cat} label={cat}>
                {available.filter(i => i.category === cat).map(i => <option key={i.id} value={i.id}>{catalogueName(i, lang)}</option>)}
              </optgroup>
            ))}
            {available.filter(i => !i.category).map(i => <option key={i.id} value={i.id}>{catalogueName(i, lang)}</option>)}
          </select>
        </div>
      ) : draftItem && (
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{catalogueName(draftItem, lang)}</p>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-price`}>{t('rates.price')}</Label>
        <MoneyInput
          id={`${uid}-price`}
          value={draft.price}
          autoFocus={draft.id !== null}
          onValueChange={v => setDraft(d => d && { ...d, price: v })}
          aria-invalid={(!!error && draft.price === null) || undefined}
          aria-describedby={draftItem ? `${uid}-default` : undefined}
        />
        {draftItem && (
          <p id={`${uid}-default`} className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('rates.defaultPrice', { price: perUnit(Number(draftItem.default_price), draftItem) })}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-note`}>{t('rates.note')}</Label>
        <Input id={`${uid}-note`} value={draft.note} onChange={e => setDraft(d => d && { ...d, note: e.target.value })} placeholder={t('rates.notePlaceholder')} />
      </div>
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {draft.id && (
          <Button type="button" variant="destructive" onClick={() => void remove()} disabled={busy}>{t('rates.remove')}</Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" onClick={close} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy}>{busy ? t('common.saving') : t('common.save')}</Button>
        </div>
      </div>
    </form>
  )

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">{t('rates.title')}</p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{t('rates.subtitle')}</p>
      </div>

      {rows.length === 0 && !draft && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {catalogue.length ? t('rates.empty') : t('rates.noCatalogue')}
          {!catalogue.length && (
            <> <Link href="/catalogue" className="underline underline-offset-2 font-medium py-2 -my-2">{t('rates.openCatalogue')}</Link></>
          )}
        </p>
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 -mx-2">
          {rows.map(({ rate, item }) => (
            <li key={rate.id} className="py-1">
              {draft?.id === rate.id ? form : (
                <button
                  type="button"
                  onClick={() => open({ id: rate.id, itemId: item.id, price: rate.price, note: rate.note ?? '' })}
                  className="w-full min-h-11 flex items-center gap-3 px-2 py-2 rounded-lg text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/60 transition-colors"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">{catalogueName(item, lang)}</span>
                    <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                      {t('rates.defaultPrice', { price: perUnit(Number(item.default_price), item) })}
                      {!item.active && ` · ${t('rates.hidden')}`}
                    </span>
                    {rate.note && <span className="block text-xs text-neutral-500 dark:text-neutral-400 truncate">{rate.note}</span>}
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-neutral-900 dark:text-neutral-100 shrink-0">
                    <span className="sr-only">{t('rates.price')}: </span>{perUnit(rate.price, item)}
                  </span>
                  <ChevronRight size={14} aria-hidden="true" className="text-neutral-400 dark:text-neutral-600 shrink-0" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {draft?.id === null ? form : available.length > 0 && (
        <button
          type="button"
          onClick={() => open({ id: null, itemId: '', price: null, note: '' })}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800/40 border border-dashed border-neutral-200 dark:border-neutral-700 transition-colors"
        >
          <Plus size={13} aria-hidden="true" /> {t('rates.add')}
        </button>
      )}
    </div>
  )
}
