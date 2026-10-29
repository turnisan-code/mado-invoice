'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FileCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { flushPendingEdits } from '@/lib/issued-pdf'
import { vatEndpoint, type EInvoiceErrorCode } from '@/lib/einvoice/common'
import { normalizeVatId } from '@/lib/utils/validation'
import { useT } from '@/lib/i18n/client'
import type { EInvoiceFormat } from '@/types'

const FORMATS: EInvoiceFormat[] = ['ebinterface', 'ubl']
const ERROR_CODES: readonly EInvoiceErrorCode[] = ['not_issued', 'unsupported_type', 'currency', 'client_country', 'buyer_reference', 'buyer_endpoint', 'seller_endpoint']

type Info = {
  currency: string
  stored: string | null
  prefill: string
  supplierNumber: string | null
  endpoint: string | null
}

type ClientRow = { einvoice_format: EInvoiceFormat | null; buyer_reference: string | null; supplier_number: string | null; peppol_scheme: string | null; peppol_id: string | null; uid_number: string | null }

// ebInterface or Peppol UBL for an issued invoice or credit note. The format comes from the
// client; the buyer reference is the document's own, else what the export would fall back to
// (src/lib/einvoice/export.ts), and is saved on the document before the XML is built.
export default function EInvoiceButton({ documentId, compact = false }: { documentId: string; compact?: boolean }) {
  const supabase = createClient()
  const router = useRouter()
  const { t } = useT()
  const uid = useId()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<Info | null>(null)
  const [format, setFormat] = useState<EInvoiceFormat>('ebinterface')
  const [reference, setReference] = useState('')
  const [referenceError, setReferenceError] = useState(false)

  async function openDialog() {
    setOpen(true)
    setLoading(true)
    setInfo(null)
    setReferenceError(false)
    try {
      await flushPendingEdits(documentId)
      const { data: doc, error } = await supabase
        .from('documents')
        .select('type, currency, buyer_reference, cancels_document_id, converted_from_id, clients(einvoice_format, buyer_reference, supplier_number, peppol_scheme, peppol_id, uid_number)')
        .eq('id', documentId)
        .single()
      if (error || !doc) throw new Error(error?.message)
      // Many-to-one: PostgREST returns the client as an object, the untyped client infers an array.
      const client = doc.clients as unknown as ClientRow | null
      let fallback: string | null = null
      if (doc.buyer_reference == null) {
        const sourceId = doc.type === 'credit_note' ? doc.cancels_document_id ?? doc.converted_from_id : null
        if (sourceId) {
          const { data: source } = await supabase.from('documents').select('buyer_reference').eq('id', sourceId).maybeSingle()
          fallback = source?.buyer_reference?.trim() || null
        }
        fallback ??= client?.buyer_reference?.trim() || null
      }
      const endpoint = client?.peppol_scheme && client.peppol_id
        ? { scheme: client.peppol_scheme, id: client.peppol_id }
        : vatEndpoint(normalizeVatId(client?.uid_number ?? '') || null)
      const prefill = doc.buyer_reference ?? fallback ?? ''
      setInfo({
        currency: doc.currency ?? 'EUR',
        stored: doc.buyer_reference,
        prefill,
        supplierNumber: client?.supplier_number?.trim() || null,
        endpoint: endpoint ? `${endpoint.scheme}:${endpoint.id}` : null,
      })
      setFormat(client?.einvoice_format ?? 'ebinterface')
      setReference(prefill)
    } catch {
      toast.error(t('einvoice.loadFailed'))
      setOpen(false)
    } finally {
      setLoading(false)
    }
  }

  async function download(e: React.FormEvent) {
    e.preventDefault()
    if (!info) return
    const value = reference.trim()
    if (format === 'ubl' && !value) { setReferenceError(true); return }
    setBusy(true)
    try {
      // '' records a reference cleared on purpose; a document never given one keeps following the fallbacks.
      const stored = value || (info.stored != null || info.prefill ? '' : null)
      if (stored !== info.stored) {
        const { error } = await supabase.from('documents').update({ buyer_reference: stored }).eq('id', documentId)
        if (error) { toast.error(t('einvoice.saveFailed', { error: error.message })); return }
        setInfo({ ...info, stored })
      }
      const res = await fetch(`/api/documents/${documentId}/einvoice?format=${format}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const code = ERROR_CODES.find(c => c === data.code)
        toast.error(code ? t(`einvoice.errors.${code}`) : t('einvoice.failed', { error: data.error || res.statusText }))
        return
      }
      const blob = await res.blob()
      const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'e-invoice.xml'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success(t('einvoice.downloaded', { file: filename }))
      setOpen(false)
      router.refresh()
    } catch (err) {
      toast.error(t('einvoice.failed', { error: err instanceof Error ? err.message : t('common.unknownError') }))
    } finally {
      setBusy(false)
    }
  }

  const hintCls = 'text-xs text-neutral-500 dark:text-neutral-400'

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => void openDialog()} title={t('einvoice.buttonTitle')} className="flex items-center gap-1.5">
        <FileCode size={14} aria-hidden="true" />
        <span className={compact ? 'sr-only sm:not-sr-only' : undefined}>{t('einvoice.button')}</span>
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title={t('einvoice.title')} description={t('einvoice.description')} busy={busy}>
        {loading || !info ? (
          <p className={hintCls} aria-live="polite">{t('einvoice.loading')}</p>
        ) : info.currency !== 'EUR' ? (
          <>
            <p className="text-sm">{t('einvoice.errors.currency')}</p>
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t('common.close')}</Button>
            </div>
          </>
        ) : (
          <form onSubmit={e => void download(e)} noValidate className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium mb-1.5">{t('einvoice.format')}</legend>
              {FORMATS.map(f => (
                <label
                  key={f}
                  className="flex items-start gap-2.5 rounded-lg border border-neutral-200 dark:border-neutral-700 p-3 cursor-pointer has-[:checked]:border-neutral-900 dark:has-[:checked]:border-neutral-200"
                >
                  <input
                    type="radio"
                    name={`${uid}-format`}
                    value={f}
                    checked={format === f}
                    onChange={() => { setFormat(f); setReferenceError(false) }}
                    className="mt-0.5 accent-neutral-900 dark:accent-white"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{t(`einvoice.formats.${f}`)}</span>
                    <span className={`block ${hintCls}`}>{t(`einvoice.formatHints.${f}`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-reference`}>{t('einvoice.buyerReference')}</Label>
              <Input
                id={`${uid}-reference`}
                value={reference}
                onChange={e => { setReference(e.target.value); setReferenceError(false) }}
                aria-invalid={referenceError || undefined}
                aria-describedby={`${uid}-reference-hint`}
                autoComplete="off"
              />
              <p id={`${uid}-reference-hint`} className={referenceError ? 'text-xs text-red-600 dark:text-red-400' : hintCls}>
                {referenceError ? t('einvoice.buyerReferenceRequired') : t('einvoice.buyerReferenceHint')}
              </p>
            </div>

            {format === 'ebinterface' ? (
              <div className="space-y-1.5">
                {!info.supplierNumber && <p className="text-xs text-amber-700 dark:text-amber-400">{t('einvoice.supplierNumberMissing')}</p>}
                <p className={hintCls}>
                  {t('einvoice.pdfNote')}{' '}
                  <a href={`/api/documents/${documentId}/pdf`} target="_blank" rel="noopener" className="underline underline-offset-2 text-neutral-700 dark:text-neutral-200">
                    {t('einvoice.openPdf')}
                  </a>
                </p>
              </div>
            ) : info.endpoint ? (
              <p className={hintCls}>{t('einvoice.endpoint', { id: info.endpoint })}</p>
            ) : (
              <p className="text-xs text-red-600 dark:text-red-400">{t('einvoice.endpointMissing')}</p>
            )}

            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={busy || (format === 'ubl' && !info.endpoint)}>
                {busy ? t('einvoice.downloading') : t('einvoice.download')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  )
}
