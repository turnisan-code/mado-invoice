// ebInterface 6.1, the Austrian e-invoice standard e-rechnung.gv.at accepts for the federal
// government (schema: github.com/austriapro/ebinterface-standards, schemas/ebInterface6p1).
// The format has no attachment element: the PDF is uploaded next to the XML as a Beilage.
import type { EInvoice, EInvoiceParty, Period, TaxKey } from './common'
import { amount, decimal, el, req, serializeXml, txt } from './xml'

const NS = 'http://www.ebinterface.at/schema/6p1/'

// Placeholder the standard prescribes for a party without a VAT number.
const NO_VAT_ID = 'ATU00000000'

// ebInterface's recommended codes: S the 20 % standard rate, AA a reduced rate.
function categoryCode(tax: TaxKey): string {
  if (tax.category === 'S') return tax.rate === 20 ? 'S' : 'AA'
  return tax.category
}

const taxPercent = (tax: TaxKey) => txt('TaxPercent', decimal(tax.rate, 2), { TaxCategoryCode: categoryCode(tax) })

function delivery(period: Period | null) {
  if (!period) return null
  return el('Delivery', null,
    period.start === period.end
      ? txt('Date', period.start)
      : el('Period', null, txt('FromDate', period.start), txt('ToDate', period.end)),
  )
}

// What the document is (ebInterface DocumentTypeType): an advance invoice is an
// InvoiceForAdvancePayment, a partial one an InvoiceForPartialDelivery, a final one the
// FinalSettlement that lists them as RelatedDocument.
const DEPOSIT_TYPES = { advance: 'InvoiceForAdvancePayment', partial: 'InvoiceForPartialDelivery', final: 'FinalSettlement' } as const

function documentType(inv: EInvoice): string {
  if (inv.kind === 'credit_note') return 'CreditMemo'
  return inv.invoiceKind === 'standard' ? 'Invoice' : DEPOSIT_TYPES[inv.invoiceKind]
}

function address(p: EInvoiceParty) {
  return el('Address', null,
    req('Name', p.name),
    txt('Street', [p.street, p.street2].filter(Boolean).join(', ')),
    req('Town', p.city),
    req('ZIP', p.zip),
    req('Country', p.countryName, { CountryCode: p.countryCode }),
    txt('Phone', p.phone),
    txt('Email', p.email),
  )
}

export function toEbInterface(inv: EInvoice): string {
  const ref = inv.reference
  const refBody = ref && [txt('InvoiceNumber', ref.number), txt('InvoiceDate', ref.date), txt('DocumentType', 'Invoice'), txt('Comment', ref.text)]

  const root = el('Invoice', {
    xmlns: NS,
    GeneratingSystem: 'Mado Invoice',
    DocumentType: documentType(inv),
    InvoiceCurrency: inv.currency,
    DocumentTitle: inv.title,
    Language: inv.language,
  },
    txt('InvoiceNumber', inv.number),
    txt('InvoiceDate', inv.issueDate),
    ref?.kind === 'storno' && el('CancelledOriginalDocument', null, refBody),
    ref?.kind === 'correction' && el('RelatedDocument', null, refBody),
    inv.preceding.map(p => el('RelatedDocument', null,
      txt('InvoiceNumber', p.number), txt('InvoiceDate', p.date), txt('DocumentType', DEPOSIT_TYPES[p.kind]), txt('Comment', p.text))),
    delivery(inv.delivery),
    el('Biller', null,
      req('VATIdentificationNumber', inv.seller.vatId ?? NO_VAT_ID),
      address(inv.seller),
      txt('InvoiceRecipientsBillerID', inv.supplierNumber),
    ),
    el('InvoiceRecipient', null,
      req('VATIdentificationNumber', inv.buyer.vatId ?? NO_VAT_ID),
      inv.buyerReference ? el('OrderReference', null, txt('OrderID', inv.buyerReference)) : null,
      address(inv.buyer),
      inv.buyer.contactName ? el('Contact', null, txt('Name', inv.buyer.contactName)) : null,
      txt('BillersInvoiceRecipientID', inv.clientNumber),
    ),
    el('Details', null,
      inv.sections.map(section => el('ItemList', null,
        txt('HeaderDescription', section.header),
        section.lines.map(line => el('ListLineItem', null,
          txt('PositionNumber', line.position),
          line.descriptionLines.map(d => txt('Description', d)),
          req('Quantity', decimal(line.quantity), { Unit: line.unitCode }),
          req('UnitPrice', decimal(line.unitPrice)),
          // The line's own discount, so Quantity × UnitPrice less it is the LineItemAmount; a
          // surcharge where it shrinks a credit line.
          line.discount !== 0 && el('ReductionAndSurchargeListLineItemDetails', null,
            el(line.discount > 0 ? 'ReductionListLineItem' : 'SurchargeListLineItem', null,
              req('BaseAmount', amount(line.gross)),
              line.discountPercent != null && txt('Percentage', decimal(line.discountPercent, 2)),
              req('Amount', amount(Math.abs(line.discount))),
              txt('Comment', line.discountReason),
            ),
          ),
          delivery(line.period),
          el('TaxItem', null,
            req('TaxableAmount', amount(line.net)),
            taxPercent(line.tax),
            (line.tax.category === 'AE' || line.tax.category === 'O') && txt('Comment', inv.taxNote),
          ),
          req('LineItemAmount', amount(line.net)),
        )),
      )),
      txt('FooterDescription', inv.footer),
    ),
    el('ReductionAndSurchargeDetails', null,
      inv.allowances.map(a => el(a.charge ? 'Surcharge' : 'Reduction', null,
        req('BaseAmount', amount(a.base)),
        a.percent != null && txt('Percentage', decimal(a.percent, 2)),
        req('Amount', amount(a.amount)),
        txt('Comment', a.reason),
        el('TaxItem', null,
          req('TaxableAmount', amount(a.amount)),
          taxPercent(a.tax),
        ),
      )),
    ),
    el('Tax', null,
      inv.taxes.map(t => el('TaxItem', null,
        req('TaxableAmount', amount(t.taxable)),
        taxPercent(t.tax),
        req('TaxAmount', amount(t.amount)),
        txt('Comment', t.exemptionReason),
      )),
    ) ?? req('Tax', null),
    req('TotalGrossAmount', amount(inv.totals.taxInclusive)),
    inv.totals.prepaid !== 0 && req('PrepaidAmount', amount(inv.totals.prepaid)),
    req('PayableAmount', amount(inv.totals.payable)),
    inv.payment && el('PaymentMethod', null,
      el('UniversalBankTransaction', null,
        el('BeneficiaryAccount', null,
          txt('BankName', inv.payment.bankName),
          txt('BIC', inv.payment.bic),
          txt('IBAN', inv.payment.iban),
          txt('BankAccountOwner', inv.payment.holder.slice(0, 70)),
        ),
        txt('PaymentReference', inv.payment.reference.slice(0, 35)),
      ),
    ),
    inv.kind === 'invoice' && el('PaymentConditions', null,
      txt('DueDate', inv.dueDate),
      inv.skonto && el('Discount', null,
        txt('PaymentDate', inv.skonto.date),
        req('BaseAmount', amount(inv.skonto.base)),
        req('Percentage', decimal(inv.skonto.percent, 2)),
        req('Amount', amount(inv.skonto.amount)),
      ),
      txt('Comment', inv.paymentTerms),
    ),
    txt('Comment', inv.note),
  )
  return serializeXml(root)
}
