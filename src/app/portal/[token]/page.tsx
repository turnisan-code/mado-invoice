import React, { cache } from 'react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Clock, Download } from 'lucide-react'
import QuoteActions from './QuoteActions'
import CopyButton from './CopyButton'
import PortalEffects from './PortalEffects'
import { createServiceClient } from '@/lib/supabase/service'
import { calcTotals, clampPercent, formatDate, formatMoney, getTaxNote, lineAmount, orderItems, paymentTermsSentence, sectionSummary, today } from '@/lib/utils/document'
import { fetchCreditReference } from '@/lib/utils/document-reference'
import { countryName } from '@/lib/utils/country'
import { epcBeneficiary, generateEpcQr } from '@/lib/utils/epc-qr'
import { isShareExpired } from '@/lib/share'
import { isExpired } from '@/lib/status'
import { paymentLineLabel, summarizePayments } from '@/lib/payment-summary'
import { StatusBadge } from '@/components/lists/StatusBadge'
import {
  docNumberLabel, docTitle, documentKind, documentLanguage, documentT, formatIban, formatPercent, formatQuantity,
  formatSignedMoney, issuerBlocks, recipientLabel, servicePeriod, statusLabel, unitLabel,
} from '@/lib/document-labels'
import type { Client, Document, DocumentItem, Payment, Settings } from '@/types'

type SharedDocument = Document & { document_items: DocumentItem[] | null; payments: Payment[] | null; clients: Client | null }

// One lookup per request, shared by generateMetadata and the page. The service client reads past
// RLS, so nothing from settings beyond what the page prints may reach the browser.
const loadShared = cache(async (token: string) => {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('documents')
    .select('*, document_items(*), payments(*), clients(*)')
    .eq('share_token', token)
    .maybeSingle()
  const doc = data as SharedDocument | null
  if (!doc?.number || !doc.clients) return null
  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings) return null
  const reference = await fetchCreditReference(supabase, doc)
  return { doc, client: doc.clients, settings: settings as Settings, reference }
})

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params
  const shared = await loadShared(token)
  if (!shared) return {}
  const { doc, settings, reference } = shared
  const t = documentT(documentLanguage(doc.language))
  if (isShareExpired(doc.share_expires_at)) return { title: t('pdfPortal.portal.expiredTitle') }
  const kind = documentKind(doc.type, reference?.kind === 'storno')
  return {
    title: t('pdfPortal.portal.pageTitle', { title: docTitle(t, kind), number: doc.number ?? '', company: settings.company_name || settings.owner_name }),
  }
}

const th = 'px-4 py-3 text-xs font-semibold text-neutral-500 uppercase tracking-wide'

function PaymentRow({ label, value, mono, copy }: {
  label: string
  value: string
  mono?: boolean
  copy?: { value: string; label: string; copied: string }
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3">
      <dt className="text-xs text-blue-700 sm:w-36 shrink-0">{label}</dt>
      <dd className="flex items-center gap-2 min-w-0">
        <span className={`break-all ${mono ? 'font-mono' : 'font-medium'}`}>{value}</span>
        {copy && <CopyButton value={copy.value} label={copy.label} copiedLabel={copy.copied} />}
      </dd>
    </div>
  )
}

export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const shared = await loadShared(token)
  if (!shared) notFound()

  const { doc, client, settings, reference } = shared
  const lang = documentLanguage(doc.language)
  const t = documentT(lang)
  const company = settings.company_name || settings.owner_name

  if (isShareExpired(doc.share_expires_at)) {
    return (
      <main lang={lang} className="max-w-md mx-auto px-4 py-24 text-center space-y-2">
        <PortalEffects lang={lang} />
        <Clock size={28} className="mx-auto mb-4 text-neutral-400" aria-hidden="true" />
        <h1 className="text-lg font-semibold">{t('pdfPortal.portal.expiredTitle')}</h1>
        <p className="text-sm text-neutral-600">{t('pdfPortal.portal.expiredBody', { company })}</p>
        {settings.email && (
          <p className="text-sm"><a href={`mailto:${settings.email}`} className="underline underline-offset-2 text-neutral-700">{settings.email}</a></p>
        )}
      </main>
    )
  }

  const items = orderItems(doc.document_items ?? [])
  const kind = documentKind(doc.type, reference?.kind === 'storno')
  const currency = doc.currency ?? 'EUR'
  const discount = doc.discount_type && doc.discount_value ? { type: doc.discount_type, value: doc.discount_value } : null
  const totals = calcTotals(items, doc.payments ?? [], discount, doc.tax_treatment)
  // Credit notes are stored with positive amounts and show as credits, as on the PDF.
  const sign = doc.type === 'credit_note' ? -1 : 1
  const money = (n: number) => formatSignedMoney(sign * n, currency)
  const pct = (n: number) => formatPercent(t, n, lang)
  const vatApplies = doc.tax_treatment === 'at_vat'
  const showVatColumn = vatApplies && new Set(items.filter(i => (i.line_type ?? 'item') === 'item' && i.vat_rate != null).map(i => i.vat_rate)).size > 1
  const columns = showVatColumn ? 5 : 4

  const issuer = issuerBlocks(settings, t, lang)
  const docPeriod = servicePeriod(doc.service_date, doc.service_date_end, lang)
  const dueLabel = doc.type === 'quote' ? t('pdfPortal.validUntil') : doc.type === 'invoice' ? t('pdfPortal.dueDate') : null
  const taxNote = getTaxNote(doc.tax_treatment ?? 'at_vat', lang, settings)
  const paymentTerms = paymentTermsSentence(doc, totals.total, lang)
  const paymentLines = summarizePayments(doc.payments ?? [])
  const expired = isExpired(doc, today())

  const payable = doc.type === 'invoice' && (doc.status === 'sent' || doc.status === 'overdue') && totals.balance_due > 0 && !!settings.iban?.trim()
  const beneficiary = epcBeneficiary(settings)
  const qr = payable && currency === 'EUR'
    ? await generateEpcQr({ iban: settings.iban, bic: settings.bic ?? '', name: beneficiary, amountEur: totals.balance_due, reference: doc.number ?? '' })
    : null
  const amountToCopy = new Intl.NumberFormat(lang === 'de' ? 'de-AT' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(totals.balance_due)
  const copyOf = (field: string, value: string) => ({ value, label: t('pdfPortal.payment.copy', { field }), copied: t('pdfPortal.payment.copied', { field }) })

  return (
    <main lang={lang} className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
      <PortalEffects lang={lang} viewToken={token} />

      <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-6 mb-8">
        <div className="min-w-0">
          {settings.logo_url
            // eslint-disable-next-line @next/next/no-img-element -- remote logo from the settings bucket
            ? <img src={settings.logo_url} alt={company} className="h-12 object-contain object-left mb-3" />
            : <div className="text-xl font-bold text-neutral-900 mb-3">{issuer.address[0]}</div>}
          <div className="text-sm text-neutral-500 space-y-0.5 break-words">
            {issuer.address.slice(settings.logo_url ? 0 : 1).map((line, i) => <div key={`a${i}`}>{line}</div>)}
            {issuer.contact.map((line, i) => <div key={`c${i}`}>{line}</div>)}
          </div>
        </div>
        <div className="sm:text-right space-y-1">
          <h1 className="text-2xl font-bold text-neutral-900">{docTitle(t, kind)}</h1>
          <div className="text-sm text-neutral-500">{docNumberLabel(t, kind)}: {doc.number}</div>
          {reference && (
            <div className="text-xs text-neutral-500">
              {t(reference.kind === 'correction' ? 'pdfPortal.correctionOf' : 'pdfPortal.stornoOf', { number: reference.number, date: formatDate(reference.date, lang) })}
            </div>
          )}
          {expired
            ? <StatusBadge status="expired" label={t('lifecycle.portal.expired')} className="inline-block" />
            : <StatusBadge status={doc.status} label={statusLabel(t, doc.status)} className="inline-block" />}
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-8">
        <div>
          <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-2">{recipientLabel(t, kind)}</h2>
          <div className="text-sm text-neutral-700 space-y-0.5 break-words">
            {client.company && <div className="font-medium">{client.company}</div>}
            {client.name && <div className={client.company ? '' : 'font-medium'}>{client.name}</div>}
            <div>{client.address_line1}</div>
            {client.address_line2 && <div>{client.address_line2}</div>}
            <div>{[client.zip, client.city].filter(Boolean).join(' ')}</div>
            <div>{countryName(client.country, lang)}</div>
            {client.uid_number && <div className="text-neutral-500 text-xs mt-1">{t('pdfPortal.issuer.uid')} {client.uid_number}</div>}
          </div>
        </div>
        <dl className="text-sm space-y-2">
          <div className="flex justify-between gap-4">
            <dt className="text-neutral-500">{t('pdfPortal.date')}</dt>
            <dd className="font-medium">{formatDate(doc.date, lang)}</dd>
          </div>
          {docPeriod && (
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-500">{docPeriod.isPeriod ? t('pdfPortal.servicePeriod') : t('pdfPortal.serviceDate')}</dt>
              <dd className="font-medium text-right">{docPeriod.text}</dd>
            </div>
          )}
          {doc.due_date && dueLabel && (
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-500">{dueLabel}</dt>
              <dd className={`font-medium ${doc.status === 'overdue' || expired ? 'text-red-600' : ''}`}>{formatDate(doc.due_date, lang)}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="mb-6 rounded-xl overflow-hidden border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50">
              <th scope="col" className={`${th} text-left`}>{t('pdfPortal.columns.description')}</th>
              <th scope="col" className={`${th} hidden sm:table-cell text-right sm:w-24`}>{t('pdfPortal.columns.quantity')}</th>
              <th scope="col" className={`${th} hidden sm:table-cell text-right sm:w-28`}>{t('pdfPortal.columns.unitPrice')}</th>
              {showVatColumn && <th scope="col" className={`${th} hidden sm:table-cell text-right sm:w-16`}>{t('pdfPortal.columns.vat')}</th>}
              <th scope="col" className={`${th} text-right sm:w-32`}>{t('pdfPortal.columns.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => {
              const lt = item.line_type ?? 'item'

              if (lt === 'separator') return <tr key={i}><td colSpan={columns} className="border-t border-neutral-100 py-0" /></tr>
              if (lt === 'page_break') return null
              if (lt === 'heading') {
                return (
                  <tr key={i} className="border-b border-neutral-100">
                    <td colSpan={columns} className="px-4 py-2.5 font-semibold text-neutral-900 whitespace-pre-line break-words">{item.description}</td>
                  </tr>
                )
              }
              if (lt === 'text') {
                return (
                  <tr key={i} className="border-b border-neutral-100">
                    <td colSpan={columns} className="px-4 py-2 text-neutral-500 text-xs whitespace-pre-line break-words">{item.description}</td>
                  </tr>
                )
              }
              if (lt === 'subtotal') {
                const sec = sectionSummary(items, i)
                return (
                  <React.Fragment key={i}>
                    <tr className="border-b border-neutral-100 bg-neutral-50">
                      <td colSpan={columns - 1} className="px-4 py-2 text-right text-xs text-neutral-500 uppercase tracking-wide font-medium">{t('pdfPortal.section.subtotal')}</td>
                      <td className={`px-4 py-2 text-right font-semibold whitespace-nowrap ${sec.discount > 0 ? 'line-through text-neutral-500' : 'text-neutral-900'}`}>{money(sec.gross)}</td>
                    </tr>
                    {sec.discount > 0 && (
                      <>
                        <tr className="border-b border-neutral-100 bg-neutral-50">
                          <td colSpan={columns - 1} className="px-4 py-1.5 text-right text-xs text-neutral-500">
                            {sec.percent != null ? t('pdfPortal.section.discountPercent', { percent: pct(sec.percent) }) : t('pdfPortal.section.discount')}
                          </td>
                          <td className="px-4 py-1.5 text-right text-xs text-neutral-500 whitespace-nowrap">{money(-sec.discount)}</td>
                        </tr>
                        <tr className="border-b border-neutral-200 bg-neutral-50">
                          <td colSpan={columns - 1} className="px-4 py-2 text-right text-xs text-neutral-500 uppercase tracking-wide font-semibold">{t('pdfPortal.section.net')}</td>
                          <td className="px-4 py-2 text-right font-bold text-neutral-900 whitespace-nowrap">{money(sec.net)}</td>
                        </tr>
                      </>
                    )}
                  </React.Fragment>
                )
              }

              if (item.quantity == null || item.unit_price == null) return null
              const period = servicePeriod(item.service_date, (item as DocumentItem & { service_date_end?: string | null }).service_date_end, lang)
              const quantity = `${formatQuantity(item.quantity, lang)}${item.unit ? ` ${unitLabel(t, item.unit, item.quantity)}` : ''}`
              const unitPrice = formatSignedMoney(item.unit_price, currency)
              const rate = item.vat_rate != null ? pct(item.vat_rate) : ''
              // The line's own discount, already taken off its amount (as on the PDF).
              const lineOff = lineAmount({ quantity: item.quantity, unit_price: item.unit_price }) - lineAmount(item)
              return (
                <tr key={i} className="border-b border-neutral-100">
                  <td className="px-4 py-3 align-top">
                    <div className="text-neutral-900 whitespace-pre-line break-words">{item.description}</div>
                    {period && <div className="text-xs text-neutral-500 mt-0.5">{period.text}</div>}
                    {lineOff > 0 && (
                      <div className="text-xs text-neutral-500 mt-0.5">
                        {item.discount_type === 'percent'
                          ? t('editor.doc.lineDiscountPercent', { percent: pct(clampPercent(item.discount_value)), amount: money(-lineOff) })
                          : t('editor.doc.lineDiscount', { amount: money(-lineOff) })}
                      </div>
                    )}
                    <div className="sm:hidden text-xs text-neutral-500 mt-0.5">
                      {quantity} × {unitPrice}{showVatColumn && rate ? ` · ${t('pdfPortal.columns.vat')} ${rate}` : ''}
                    </div>
                  </td>
                  <td className="hidden sm:table-cell px-4 py-3 text-right text-neutral-600 whitespace-nowrap align-top">{quantity}</td>
                  <td className="hidden sm:table-cell px-4 py-3 text-right text-neutral-600 whitespace-nowrap align-top">{unitPrice}</td>
                  {showVatColumn && <td className="hidden sm:table-cell px-4 py-3 text-right text-neutral-600 whitespace-nowrap align-top">{rate}</td>}
                  <td className="px-4 py-3 text-right font-medium text-neutral-900 whitespace-nowrap align-top">{money(lineAmount(item))}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end mb-6">
        <dl className="w-full sm:w-72 space-y-1.5 text-sm">
          <div className="flex justify-between gap-4 text-neutral-500">
            <dt>{t('pdfPortal.totals.net')}</dt>
            <dd>{money(totals.subtotal)}</dd>
          </div>
          {totals.discount_amount > 0 && (
            <div className="flex justify-between gap-4 text-neutral-500">
              <dt>
                {doc.discount_type === 'percent' && doc.discount_value
                  ? t('pdfPortal.totals.discountPercent', { percent: pct(clampPercent(doc.discount_value)) })
                  : t('pdfPortal.totals.discount')}
              </dt>
              <dd>{money(-totals.discount_amount)}</dd>
            </div>
          )}
          {vatApplies && totals.vat_groups.map(g => (
            <React.Fragment key={g.rate}>
              <div className="flex justify-between gap-4 text-neutral-500">
                <dt>{t('pdfPortal.totals.netAtRate', { rate: pct(g.rate) })}</dt>
                <dd>{money(g.base)}</dd>
              </div>
              <div className="flex justify-between gap-4 text-neutral-500">
                <dt>{t('pdfPortal.totals.vatAtRate', { rate: pct(g.rate) })}</dt>
                <dd>{money(g.amount)}</dd>
              </div>
            </React.Fragment>
          ))}
          <div className="border-t border-neutral-200 pt-1.5 flex justify-between gap-4 font-semibold text-neutral-900 text-base">
            <dt>{doc.type === 'credit_note' ? t('pdfPortal.totals.creditTotal') : t('pdfPortal.totals.total')}</dt>
            <dd>{money(totals.total)}</dd>
          </div>
          {doc.type === 'invoice' && totals.total_paid > 0 && (
            <>
              {paymentLines.map((line, i) => (
                <div key={i} className="flex justify-between gap-4 text-neutral-500">
                  <dt>{paymentLineLabel(t, line)}</dt>
                  <dd className={line.kind === 'paid' ? 'text-green-700' : ''}>{money(-line.amount)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-4 font-semibold text-neutral-900">
                <dt>{t('pdfPortal.totals.balanceDue')}</dt>
                <dd className={totals.balance_due > 0 ? 'text-red-600' : 'text-green-700'}>{money(totals.balance_due)}</dd>
              </div>
            </>
          )}
        </dl>
      </div>

      {(paymentTerms || taxNote) && (
        <div className="mb-8 space-y-1 text-sm text-neutral-600 sm:text-right">
          {paymentTerms && <p>{paymentTerms}</p>}
          {taxNote && <p className="italic text-neutral-500">{taxNote}</p>}
        </div>
      )}

      {doc.notes && (
        <section className="mb-6 rounded-xl border border-neutral-200 bg-white px-4 py-3">
          <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">{t('pdfPortal.portal.notes')}</h2>
          <p className="text-sm text-neutral-600 whitespace-pre-line break-words">{doc.notes}</p>
        </section>
      )}

      {payable && (
        <section aria-labelledby="portal-payment" className="mb-6 rounded-xl border border-blue-100 bg-blue-50 px-4 py-4">
          <h2 id="portal-payment" className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-3">{t('pdfPortal.payment.title')}</h2>
          <div className="flex flex-col sm:flex-row gap-5">
            {qr && (
              <figure className="shrink-0 self-center sm:self-start">
                {/* eslint-disable-next-line @next/next/no-img-element -- generated data URI */}
                <img src={qr} alt="" width={148} height={148} className="rounded-md bg-white p-1.5" />
                <figcaption className="text-xs text-blue-700 mt-1.5 text-center max-w-[148px]">{t('pdfPortal.payment.qrCaption')}</figcaption>
              </figure>
            )}
            <dl className="flex-1 min-w-0 text-sm text-blue-950 space-y-2.5">
              <PaymentRow label={t('pdfPortal.payment.accountHolder')} value={beneficiary} />
              {settings.bank_name && <PaymentRow label={t('pdfPortal.payment.bank')} value={settings.bank_name} />}
              <PaymentRow
                label={t('pdfPortal.payment.iban')}
                value={formatIban(settings.iban)}
                mono
                copy={copyOf(t('pdfPortal.payment.iban'), settings.iban.replace(/\s/g, '').toUpperCase())}
              />
              {settings.bic?.trim() && (
                <PaymentRow label={t('pdfPortal.payment.bic')} value={settings.bic.trim()} mono copy={copyOf(t('pdfPortal.payment.bic'), settings.bic.trim())} />
              )}
              <PaymentRow
                label={t('pdfPortal.payment.amount')}
                value={formatMoney(totals.balance_due, currency)}
                copy={copyOf(t('pdfPortal.payment.amount'), amountToCopy)}
              />
              <PaymentRow
                label={t('pdfPortal.payment.reference')}
                value={doc.number ?? ''}
                mono
                copy={copyOf(t('pdfPortal.payment.reference'), doc.number ?? '')}
              />
            </dl>
          </div>
        </section>
      )}

      <div className="flex items-center justify-between gap-4 flex-wrap pt-2">
        <a
          href={`/portal/${token}/pdf`}
          download
          className="inline-flex items-center gap-2 border border-neutral-200 bg-white text-neutral-700 text-sm px-4 py-2.5 rounded-lg hover:bg-neutral-50 transition-colors"
        >
          <Download size={15} aria-hidden="true" />
          {t('pdfPortal.portal.downloadPdf')}
        </a>
        {doc.type === 'quote' && doc.status === 'sent' && (expired ? (
          <div role="status" className="flex items-start gap-2 text-sm text-neutral-600 max-w-sm">
            <Clock size={15} className="mt-0.5 shrink-0 text-red-600" aria-hidden="true" />
            <div>
              <p className="font-medium text-neutral-900">{t('lifecycle.portal.expiredNotice', { date: formatDate(doc.due_date!, lang) })}</p>
              <p>{t('lifecycle.portal.expiredHint')}</p>
            </div>
          </div>
        ) : (
          <QuoteActions token={token} lang={lang} />
        ))}
      </div>
    </main>
  )
}
