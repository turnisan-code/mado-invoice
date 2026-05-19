import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import DocumentBuilder from '@/components/forms/DocumentBuilder'
import DocumentStatusBar from '@/components/layout/DocumentStatusBar'
import ConvertToInvoiceButton from '@/components/layout/ConvertToInvoiceButton'
import DuplicateDocumentButton from '@/components/layout/DuplicateDocumentButton'
import DeleteDocumentButton from '@/components/layout/DeleteDocumentButton'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const [{ data: doc }, { data: settings }, { data: clients }, { data: catalogue }] = await Promise.all([
    supabase.from('documents').select('*, document_items(*), payments(*)').eq('id', id).single(),
    supabase.from('settings').select('*').single(),
    supabase.from('clients').select('id, name, company, email, language, currency, payment_days, tax_treatment, address_line1, address_line2, zip, city, country, uid_number').order('name'),
    supabase.from('catalogue_items').select('*').order('sort_order'),
  ])

  if (!doc) notFound()

  const docWithItems = { ...doc, items: doc.document_items ?? [], payments: doc.payments ?? [] }

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/quotes" className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors">
          <ArrowLeft size={16} />
        </Link>
        <h1 className="text-2xl font-semibold">{doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">Draft</span>}</h1>
        <DocumentStatusBar document={doc} />
        {!['accepted', 'rejected', 'cancelled'].includes(doc.status) && (
          <ConvertToInvoiceButton quoteId={doc.id} />
        )}
        <DuplicateDocumentButton docId={doc.id} docType="quote" backTo="/quotes" />
        <DeleteDocumentButton id={doc.id} backTo="/quotes" docNumber={doc.number} docType="quote" />
      </div>
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6">
        <DocumentBuilder
          type="quote"
          settings={settings!}
          clients={clients ?? []}
          catalogue={catalogue ?? []}
          document={docWithItems}
        />
      </div>
    </div>
  )
}
