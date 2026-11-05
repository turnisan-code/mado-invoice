// Peppol BIS Billing 3.0: a UBL 2.1 Invoice or CreditNote conforming to EN 16931.
import { EInvoiceError, type EInvoice, type EInvoiceParty, type Period, type TaxKey } from './common'
import { amount, decimal, el, serializeXml, txt, type XmlElement } from './xml'

const NS = {
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  credit_note: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
}

export const PEPPOL_CUSTOMIZATION_ID = 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0'
export const PEPPOL_PROFILE_ID = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0'

// UNCL 4461: SEPA credit transfer. UNCL 5189: discount.
const SEPA_CREDIT_TRANSFER = '58'
const DISCOUNT_REASON = '95'

type Money = { currencyID: string }

const vat = () => el('cac:TaxScheme', null, txt('cbc:ID', 'VAT'))

// "Not subject to VAT" carries no rate at all (BR-O-05, BR-O-06, BR-O-07).
const percent = (tax: TaxKey) => (tax.category === 'O' ? null : txt('cbc:Percent', decimal(tax.rate, 2)))

function period(name: string, p: Period | null) {
  return p ? el(name, null, txt('cbc:StartDate', p.start), txt('cbc:EndDate', p.end)) : null
}

function postalAddress(p: EInvoiceParty) {
  return el('cac:PostalAddress', null,
    txt('cbc:StreetName', p.street),
    txt('cbc:AdditionalStreetName', p.street2),
    txt('cbc:CityName', p.city),
    txt('cbc:PostalZone', p.zip),
    el('cac:Country', null, txt('cbc:IdentificationCode', p.countryCode)),
  )
}

function party(p: EInvoiceParty, opts: { withVat: boolean; identifier: string | null; contact: boolean }): XmlElement | null {
  return el('cac:Party', null,
    txt('cbc:EndpointID', p.endpoint?.id, { schemeID: p.endpoint?.scheme }),
    opts.identifier ? el('cac:PartyIdentification', null, txt('cbc:ID', opts.identifier)) : null,
    el('cac:PartyName', null, txt('cbc:Name', p.name)),
    postalAddress(p),
    opts.withVat && p.vatId ? el('cac:PartyTaxScheme', null, txt('cbc:CompanyID', p.vatId), vat()) : null,
    el('cac:PartyLegalEntity', null, txt('cbc:RegistrationName', p.name)),
    opts.contact
      ? el('cac:Contact', null, txt('cbc:Name', p.contactName), txt('cbc:Telephone', p.phone), txt('cbc:ElectronicMail', p.email))
      : null,
  )
}

export function toUbl(inv: EInvoice): string {
  if (!inv.seller.endpoint) throw new EInvoiceError('seller_endpoint', 'The seller has no Peppol address')
  if (!inv.buyer.endpoint) throw new EInvoiceError('buyer_endpoint', 'The client has no Peppol address')
  // PEPPOL-EN16931-R003: a buyer reference or a purchase order reference.
  if (!inv.buyerReference) throw new EInvoiceError('buyer_reference', 'Peppol needs a buyer reference')

  const credit = inv.kind === 'credit_note'
  const money: Money = { currencyID: inv.currency }
  // BR-O-02: a document outside the scope of VAT names no VAT numbers; the seller is then
  // identified by its VAT number as a plain identifier (BR-CO-26).
  const outOfScope = inv.taxes.some(t => t.tax.category === 'O')

  // PEPPOL-EN16931-R110/R111: line periods lie within the document's invoicing period.
  const linePeriods = inv.lines.map(l => l.period).filter((p): p is Period => !!p)
  const docPeriod = inv.delivery && inv.delivery.start !== inv.delivery.end
    ? {
        start: [inv.delivery.start, ...linePeriods.map(p => p.start)].sort()[0],
        end: [inv.delivery.end, ...linePeriods.map(p => p.end)].sort().reverse()[0],
      }
    : null
  const deliveryDate = inv.delivery && inv.delivery.start === inv.delivery.end ? inv.delivery.start : null

  const lineName = credit ? 'cac:CreditNoteLine' : 'cac:InvoiceLine'
  const quantityName = credit ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity'

  const root = el(credit ? 'CreditNote' : 'Invoice', {
    xmlns: credit ? NS.credit_note : NS.invoice,
    'xmlns:cac': NS.cac,
    'xmlns:cbc': NS.cbc,
  },
    txt('cbc:CustomizationID', PEPPOL_CUSTOMIZATION_ID),
    txt('cbc:ProfileID', PEPPOL_PROFILE_ID),
    txt('cbc:ID', inv.number),
    txt('cbc:IssueDate', inv.issueDate),
    !credit && txt('cbc:DueDate', inv.dueDate),
    credit ? txt('cbc:CreditNoteTypeCode', '381') : txt('cbc:InvoiceTypeCode', '380'),
    // PEPPOL-EN16931-R002: at most one note.
    txt('cbc:Note', inv.note),
    txt('cbc:DocumentCurrencyCode', inv.currency),
    txt('cbc:BuyerReference', inv.buyerReference),
    period('cac:InvoicePeriod', docPeriod),
    el('cac:OrderReference', null, txt('cbc:ID', inv.buyerReference)),
    inv.reference ? el('cac:BillingReference', null,
      el('cac:InvoiceDocumentReference', null, txt('cbc:ID', inv.reference.number), txt('cbc:IssueDate', inv.reference.date)),
    ) : null,
    inv.attachment ? el('cac:AdditionalDocumentReference', null,
      txt('cbc:ID', inv.number),
      txt('cbc:DocumentDescription', inv.attachment.description),
      el('cac:Attachment', null,
        txt('cbc:EmbeddedDocumentBinaryObject', inv.attachment.base64, { mimeCode: 'application/pdf', filename: inv.attachment.filename }),
      ),
    ) : null,
    el('cac:AccountingSupplierParty', null,
      party(inv.seller, { withVat: !outOfScope, identifier: inv.supplierNumber ?? (outOfScope ? inv.seller.vatId : null), contact: true }),
    ),
    el('cac:AccountingCustomerParty', null,
      party(inv.buyer, { withVat: !outOfScope, identifier: null, contact: true }),
    ),
    deliveryDate ? el('cac:Delivery', null, txt('cbc:ActualDeliveryDate', deliveryDate)) : null,
    inv.payment ? el('cac:PaymentMeans', null,
      txt('cbc:PaymentMeansCode', SEPA_CREDIT_TRANSFER),
      txt('cbc:PaymentID', inv.payment.reference),
      el('cac:PayeeFinancialAccount', null,
        txt('cbc:ID', inv.payment.iban),
        txt('cbc:Name', inv.payment.holder),
        inv.payment.bic ? el('cac:FinancialInstitutionBranch', null, txt('cbc:ID', inv.payment.bic)) : null,
      ),
    ) : null,
    el('cac:PaymentTerms', null, txt('cbc:Note', inv.paymentTerms)),
    inv.allowances.map(a => el('cac:AllowanceCharge', null,
      txt('cbc:ChargeIndicator', a.charge ? 'true' : 'false'),
      !a.charge && a.discount && txt('cbc:AllowanceChargeReasonCode', DISCOUNT_REASON),
      txt('cbc:AllowanceChargeReason', a.reason),
      a.percent != null && txt('cbc:MultiplierFactorNumeric', decimal(a.percent, 2)),
      txt('cbc:Amount', amount(a.amount), money),
      a.percent != null && txt('cbc:BaseAmount', amount(a.base), money),
      el('cac:TaxCategory', null, txt('cbc:ID', a.tax.category), percent(a.tax), vat()),
    )),
    el('cac:TaxTotal', null,
      txt('cbc:TaxAmount', amount(inv.totals.taxTotal), money),
      inv.taxes.map(t => el('cac:TaxSubtotal', null,
        txt('cbc:TaxableAmount', amount(t.taxable), money),
        txt('cbc:TaxAmount', amount(t.amount), money),
        el('cac:TaxCategory', null,
          txt('cbc:ID', t.tax.category),
          percent(t.tax),
          txt('cbc:TaxExemptionReasonCode', t.exemptionCode),
          txt('cbc:TaxExemptionReason', t.exemptionReason),
          vat(),
        ),
      )),
    ),
    el('cac:LegalMonetaryTotal', null,
      txt('cbc:LineExtensionAmount', amount(inv.totals.lineTotal), money),
      txt('cbc:TaxExclusiveAmount', amount(inv.totals.taxExclusive), money),
      txt('cbc:TaxInclusiveAmount', amount(inv.totals.taxInclusive), money),
      inv.totals.allowanceTotal !== 0 && txt('cbc:AllowanceTotalAmount', amount(inv.totals.allowanceTotal), money),
      inv.totals.chargeTotal !== 0 && txt('cbc:ChargeTotalAmount', amount(inv.totals.chargeTotal), money),
      inv.totals.prepaid !== 0 && txt('cbc:PrepaidAmount', amount(inv.totals.prepaid), money),
      txt('cbc:PayableAmount', amount(inv.totals.payable), money),
    ),
    inv.lines.map(line => el(lineName, null,
      txt('cbc:ID', line.position),
      txt(quantityName, decimal(line.quantity), { unitCode: line.unitCode }),
      txt('cbc:LineExtensionAmount', amount(line.net), money),
      period('cac:InvoicePeriod', line.period),
      el('cac:Item', null,
        txt('cbc:Description', line.descriptionLines.slice(1).join('\n')),
        txt('cbc:Name', line.name),
        el('cac:ClassifiedTaxCategory', null, txt('cbc:ID', line.tax.category), percent(line.tax), vat()),
      ),
      el('cac:Price', null, txt('cbc:PriceAmount', decimal(line.unitPrice), money)),
    )),
  )
  return serializeXml(root)
}
