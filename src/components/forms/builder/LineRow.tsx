'use client'

import { useId, useState } from 'react'
import { Calendar, ChevronDown, ChevronUp, GripVertical, Percent, Trash2 } from 'lucide-react'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { formatDate, formatMoney, lineSummary, sectionSummary } from '@/lib/utils/document'
import { catalogueLineText, cataloguePrice, hasClientRate, type RateMap } from '@/lib/utils/catalogue'
import { formatLocaleNumber } from '@/lib/utils/number'
import { useT } from '@/lib/i18n/client'
import type { CatalogueItem, Currency, Language, Unit, VatRate } from '@/types'
import { AnchoredPopover, anchorTo, type PopoverAnchor } from './AnchoredPopover'
import { AutoTextarea } from './AutoTextarea'
import { CatalogueField } from './CatalogueField'
import { DateInput } from './DateInput'
import { DiscountControls } from './DiscountControls'
import { UNITS, VAT_RATES, clampDiscount, type DiscountKind, type LineItem } from './model'
import type { useReorder } from './useReorder'

export const INVALID_CLS = 'border-red-400 dark:border-red-500'
const LINE_SELECT_CLS = 'h-9 sm:h-8 min-w-0 border border-neutral-200 dark:border-neutral-700 rounded-md px-2 text-base md:text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100'
const DESCRIPTION_CLS = 'w-full min-h-9 sm:min-h-8 rounded-lg border border-input bg-transparent px-2.5 py-1.5 sm:py-1 text-base md:text-sm leading-snug outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30'
const iconBtn = 'flex items-center justify-center rounded-md transition-colors shrink-0'
const mutedBtn = 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300'

// The desktop grid: handle, description, quantity, unit, price, [VAT], discount, date, delete.
export function itemColumns(vatApplies: boolean) {
  return `16px 1fr 70px 80px 90px ${vatApplies ? '60px ' : ''}24px 24px 32px`
}

export interface LineIssues { description: boolean; quantity: boolean; price: boolean; date: boolean; discount: boolean }

interface Props {
  line: LineItem
  index: number
  count: number
  lines: LineItem[]
  currency: Currency
  language: Language
  vatApplies: boolean
  issues: LineIssues
  catalogue: CatalogueItem[]
  clientRates: RateMap
  onCatalogueItemCreated: (item: CatalogueItem) => void
  update: (patch: Partial<LineItem>) => void
  remove: () => void
  move: (delta: -1 | 1) => void
  reorder: ReturnType<typeof useReorder>
}

// One line of the document, the same markup on every screen: a card with move buttons on a
// phone, a grid row with a drag handle (Alt+↑/↓ moves it too) from the sm breakpoint.
export function LineRow({ line, index, count, lines, currency, language, vatApplies, issues, catalogue, clientRates, onCatalogueItemCreated, update, remove, move, reorder }: Props) {
  const { t, lang } = useT()
  const uid = useId()
  const [popover, setPopover] = useState<{ kind: 'date' | 'discount'; anchor: PopoverAnchor } | null>(null)
  const position = index + 1

  // Not a <button>: Firefox does not start a drag from one.
  const handle = (
    <span
      role="button"
      tabIndex={0}
      {...reorder.handleProps(line.id)}
      aria-label={t('editor.reorder.handle', { position, count })}
      title={t('editor.reorder.hint')}
      className={`hidden sm:flex h-9 w-4 ${iconBtn} cursor-grab active:cursor-grabbing text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400`}
    >
      <GripVertical size={14} aria-hidden="true" />
    </span>
  )
  const moveButtons = (
    <div className="flex sm:hidden shrink-0">
      <button type="button" data-move onClick={() => move(-1)} disabled={index === 0} aria-label={t('editor.reorder.up', { position })}
        className={`h-11 w-9 ${iconBtn} ${mutedBtn} disabled:opacity-30`}>
        <ChevronUp size={16} />
      </button>
      <button type="button" data-move onClick={() => move(1)} disabled={index === count - 1} aria-label={t('editor.reorder.down', { position })}
        className={`h-11 w-9 ${iconBtn} ${mutedBtn} disabled:opacity-30`}>
        <ChevronDown size={16} />
      </button>
    </div>
  )
  const deleteBtn = (className = '') => (
    <button type="button" onClick={remove} aria-label={t('builder.removeLine')}
      className={`h-11 w-11 sm:h-9 sm:w-8 ${iconBtn} text-neutral-400 dark:text-neutral-500 hover:text-red-500 dark:hover:text-red-400 ${className}`}>
      <Trash2 size={14} />
    </button>
  )
  const rowCls = `${reorder.indicatorCls(line.id)} ${reorder.dragging === line.id ? 'opacity-50' : ''}`

  if (line.line_type === 'separator' || line.line_type === 'page_break') {
    return (
      <div {...reorder.rowProps(line.id)} className={`flex items-center gap-2 py-1 ${rowCls}`}>
        {handle}
        {line.line_type === 'separator' ? (
          <div className="flex-1 border-t border-neutral-200 dark:border-neutral-700" />
        ) : (
          <>
            <div className="flex-1 border-t border-dashed border-neutral-300 dark:border-neutral-600" />
            <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0 px-1">{t('builder.pageBreak')}</span>
            <div className="flex-1 border-t border-dashed border-neutral-300 dark:border-neutral-600" />
          </>
        )}
        {moveButtons}
        {deleteBtn()}
      </div>
    )
  }

  if (line.line_type === 'heading' || line.line_type === 'text') {
    const heading = line.line_type === 'heading'
    return (
      <div {...reorder.rowProps(line.id)} className={`flex items-start gap-2 ${rowCls}`}>
        {handle}
        <AutoTextarea
          value={line.description}
          onChange={e => update({ description: e.target.value })}
          placeholder={heading ? t('builder.sectionHeadingPlaceholder') : t('builder.notePlaceholder')}
          aria-label={heading ? t('builder.sectionHeading') : t('builder.note')}
          className={heading
            ? 'flex-1 min-w-0 text-base md:text-sm font-semibold bg-transparent border-0 border-b border-neutral-200 dark:border-neutral-700 px-1 py-1.5 focus:outline-none focus:border-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-600'
            : 'flex-1 min-w-0 text-base md:text-sm text-neutral-500 dark:text-neutral-400 bg-transparent border-0 border-b border-neutral-100 dark:border-neutral-800 px-1 py-1.5 focus:outline-none focus:border-neutral-300 dark:placeholder:text-neutral-600'}
        />
        {moveButtons}
        {deleteBtn()}
      </div>
    )
  }

  if (line.line_type === 'subtotal') {
    const { gross, discount, net } = sectionSummary(lines, index)
    const setDiscount = (kind: DiscountKind, value: number) =>
      update({ discount_type: kind, discount_value: clampDiscount(kind, value, gross) })
    return (
      <div {...reorder.rowProps(line.id)} className={`flex items-start gap-2 py-1 sm:py-1.5 ${rowCls}`}>
        {handle}
        <div className="flex-1 space-y-1.5 pr-1 min-w-0">
          <div className="flex justify-end items-center gap-3 min-h-9 sm:min-h-0">
            <span className="text-xs text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">{t('builder.subtotal')}</span>
            <span className={`text-sm font-medium ${discount > 0 ? 'line-through text-neutral-500 dark:text-neutral-400' : ''}`}>{formatMoney(gross, currency)}</span>
          </div>
          {line.discount_type ? (
            <>
              <DiscountControls
                kind={line.discount_type}
                value={line.discount_value}
                amount={discount}
                currency={currency}
                label={t('builder.sectionDiscount')}
                onChange={setDiscount}
                onRemove={() => update({ discount_type: null, discount_value: 0 })}
              />
              <div className="flex justify-end gap-3">
                <span className="text-xs text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">{t('builder.net')}</span>
                <span className="text-sm font-semibold">{formatMoney(net, currency)}</span>
              </div>
            </>
          ) : (
            <div className="flex justify-end">
              <button type="button" onClick={() => update({ discount_type: 'percent', discount_value: 0 })}
                className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 border border-dashed border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 rounded px-2 py-1 sm:py-0.5 transition-colors">
                + {t('builder.discount')}
              </button>
            </div>
          )}
        </div>
        {moveButtons}
        {deleteBtn()}
      </div>
    )
  }

  const summary = lineSummary(line)
  const setLineDiscount = (kind: DiscountKind, value: number) =>
    update({ discount_type: kind, discount_value: clampDiscount(kind, value, summary.gross) })
  const dateLabel = !line.service_date
    ? t('builder.setServiceDate')
    : line.service_date_end && line.service_date_end !== line.service_date
      ? t('issueChecks.servicePeriodLabel', { from: formatDate(line.service_date, lang), to: formatDate(line.service_date_end, lang) })
      : t('builder.serviceDateLabel', { date: formatDate(line.service_date, lang) })
  const discountLabel = line.discount_type && summary.discount > 0
    ? (summary.percent != null ? `−${formatLocaleNumber(summary.percent, 2)} % · ` : '') + `−${formatMoney(summary.discount, currency)}`
    : null
  const open = (kind: 'date' | 'discount', height: number) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = anchorTo(e.currentTarget, height)
    setPopover(p => (p?.kind === kind ? null : { kind, anchor }))
  }
  const toolBtn = (active: boolean, invalid: boolean) =>
    `h-11 w-11 border sm:h-9 sm:w-6 sm:border-0 ${iconBtn} ${invalid ? `${INVALID_CLS} text-red-500` : active ? 'border-blue-300 dark:border-blue-700 text-blue-500' : `border-neutral-200 dark:border-neutral-700 ${mutedBtn}`}`

  return (
    <div
      {...reorder.rowProps(line.id)}
      className={`rounded-xl border border-neutral-200 dark:border-neutral-700 p-3 mb-2 space-y-3 sm:mb-0 sm:space-y-0 sm:grid sm:gap-2 sm:items-start sm:rounded-none sm:border-0 sm:p-0 ${rowCls}`}
      style={{ gridTemplateColumns: itemColumns(vatApplies) }}
    >
      {handle}
      <div className="flex items-start gap-2 sm:contents">
        <div className="flex-1 min-w-0 space-y-0.5">
          <CatalogueField
            value={line.description}
            language={language}
            items={catalogue}
            rates={clientRates}
            invalid={issues.description}
            className={DESCRIPTION_CLS}
            onChange={description => update({ description })}
            onPick={item => update({
              description: catalogueLineText(item, language),
              unit_price: cataloguePrice(item, clientRates),
              unit: item.unit as Unit,
              vat_rate: item.vat_rate as VatRate,
              catalogue_item_id: item.id,
            })}
            onItemCreated={onCatalogueItemCreated}
          />
          {hasClientRate(line, clientRates) && <p className="px-1 text-xs text-neutral-500 dark:text-neutral-400">{t('rates.clientRate')}</p>}
          {discountLabel && <p className="px-1 text-xs text-neutral-500 dark:text-neutral-400">{t('editor.lineDiscountNote', { discount: discountLabel })}</p>}
        </div>
        {deleteBtn('sm:order-last')}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:contents">
        <div className="space-y-1 sm:space-y-0 sm:contents">
          <label htmlFor={`${uid}-qty`} className="block text-xs text-neutral-500 dark:text-neutral-400 sm:sr-only">{t('builder.qtyUnit')}</label>
          <div className="flex gap-1.5 sm:contents">
            <MoneyInput id={`${uid}-qty`} value={line.quantity} decimals={4} aria-invalid={issues.quantity || undefined}
              onValueChange={n => update({ quantity: n ?? 0 })} className="w-16 shrink-0 sm:w-full" />
            <select value={line.unit} onChange={e => update({ unit: e.target.value as Unit })} aria-label={t('builder.unit')}
              className={`${LINE_SELECT_CLS} flex-1`}>
              {UNITS.map(u => <option key={u} value={u}>{t(`units.${u}`)}</option>)}
            </select>
          </div>
        </div>
        <div className="space-y-1 sm:space-y-0 sm:contents">
          <label htmlFor={`${uid}-price`} className="block text-xs text-neutral-500 dark:text-neutral-400 sm:sr-only">{t('builder.unitPrice')}</label>
          <MoneyInput id={`${uid}-price`} value={line.unit_price} aria-invalid={issues.price || undefined}
            onValueChange={n => update({ unit_price: n ?? 0 })} className="w-full" />
        </div>
      </div>
      <div className="flex items-end gap-2 sm:contents">
        {vatApplies ? (
          <div className="space-y-1 sm:space-y-0 flex-1 min-w-0 sm:contents">
            <label htmlFor={`${uid}-vat`} className="block text-xs text-neutral-500 dark:text-neutral-400 sm:sr-only">{t('builder.vatRate')}</label>
            <select id={`${uid}-vat`} value={line.vat_rate} onChange={e => update({ vat_rate: parseInt(e.target.value) as VatRate })}
              className={`${LINE_SELECT_CLS} w-full`}>
              {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
            </select>
          </div>
        ) : <div className="flex-1 sm:hidden" />}
        <button type="button" onClick={open('discount', 170)} title={t('editor.lineDiscount')} aria-label={discountLabel ? t('editor.lineDiscountNote', { discount: discountLabel }) : t('editor.lineDiscount')}
          aria-expanded={popover?.kind === 'discount'} className={toolBtn(!!discountLabel, issues.discount)}>
          <Percent size={14} />
        </button>
        <button type="button" onClick={open('date', 180)} title={dateLabel} aria-label={dateLabel}
          aria-expanded={popover?.kind === 'date'} className={toolBtn(!!line.service_date, issues.date)}>
          <Calendar size={14} />
        </button>
        {moveButtons}
      </div>

      {popover?.kind === 'date' && (
        <AnchoredPopover anchor={popover.anchor} label={t('builder.serviceDate')} onClose={() => setPopover(null)}>
          <label htmlFor={`${uid}-service-date`} className="block text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('builder.serviceDate')}</label>
          <DateInput id={`${uid}-service-date`} value={line.service_date ?? ''} autoFocus className="w-44"
            onValueChange={v => update(v ? { service_date: v } : { service_date: null, service_date_end: null })} />
          <label htmlFor={`${uid}-service-date-end`} className="block text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('issueChecks.serviceUntil')}</label>
          <DateInput id={`${uid}-service-date-end`} value={line.service_date_end ?? ''} className="w-44"
            min={line.service_date ?? undefined} disabled={!line.service_date}
            aria-invalid={(!!line.service_date && !!line.service_date_end && line.service_date_end < line.service_date) || undefined}
            onValueChange={v => update({ service_date_end: v || null })} />
          {(line.service_date || line.service_date_end) && (
            <button type="button" onClick={() => { update({ service_date: null, service_date_end: null }); setPopover(null) }}
              className="text-xs py-2 -my-1 text-neutral-500 dark:text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors">
              {t('builder.clearDate')}
            </button>
          )}
        </AnchoredPopover>
      )}
      {popover?.kind === 'discount' && (
        <AnchoredPopover anchor={popover.anchor} label={t('editor.lineDiscount')} onClose={() => setPopover(null)}>
          <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('editor.lineDiscount')}</p>
          <DiscountControls
            kind={line.discount_type ?? 'percent'}
            value={line.discount_value}
            amount={summary.discount}
            currency={currency}
            label={t('editor.lineDiscountValue')}
            autoFocus
            onChange={setLineDiscount}
            onRemove={() => { update({ discount_type: null, discount_value: 0 }); setPopover(null) }}
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400 text-right">{t('editor.lineNet', { amount: formatMoney(summary.net, currency) })}</p>
        </AnchoredPopover>
      )}
    </div>
  )
}
