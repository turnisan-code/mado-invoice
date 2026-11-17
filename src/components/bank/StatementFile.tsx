'use client'

// The statement file of the „Kontoauszug“ page: dropped or chosen, read in the browser
// (lib/bank/parse.ts), shown with its format, its number of lines and anything not read. Both
// tabs work on it: „Einnahmen“ records the invoices' payments, „Ausgaben“ books the rest.
import { useRef, useState } from 'react'
import { AlertTriangle, FileText, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { decodeStatement, parseStatement } from '@/lib/bank/parse'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey } from '@/lib/i18n'
import { MAX_WARNINGS, warningText, type LoadedStatement } from './BankImport'

export default function StatementFile({ statement, onStatement }: { statement: LoadedStatement | null; onStatement: (s: LoadedStatement | null) => void }) {
  const { t } = useT()
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [warningsOpen, setWarningsOpen] = useState(false)
  const plural = (count: number, one: DictKey, other: DictKey) => n(count, t(one, { count }), t(other, { count }))
  const parsed = statement?.parsed ?? null
  const warnings = parsed?.warnings ?? []

  async function loadFile(file: File) {
    try {
      const text = decodeStatement(await file.arrayBuffer())
      const next = parseStatement(text, { xmlParser: xml => new DOMParser().parseFromString(xml, 'application/xml') })
      setWarningsOpen(false)
      onStatement({ parsed: next, fileName: file.name })
    } catch {
      toast.error(t('bankImport.readFailed'))
    }
  }

  return (
    <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6 space-y-3">
      {!parsed ? (
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) void loadFile(f) }}
          className={`rounded-lg border-2 border-dashed p-6 sm:p-10 text-center transition-colors ${dragOver ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30' : 'border-neutral-300 dark:border-neutral-700'}`}
        >
          <Upload size={28} className="mx-auto mb-3 text-neutral-300 dark:text-neutral-600" />
          <p className="text-sm font-medium">{t('bankImport.dropzone')}</p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{t('bankImport.dropzoneHint')}</p>
          <Button type="button" onClick={() => fileInput.current?.click()} className="mt-4 px-4">{t('bankImport.chooseFile')}</Button>
        </div>
      ) : (
        <div className="flex items-center gap-3 min-w-0">
          <FileText size={16} className="text-neutral-400 dark:text-neutral-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{statement?.fileName}</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {parsed.format === 'camt' ? t('bankImport.formatCamt') : parsed.format === 'easybank' ? t('bankImport.formatEasybank') : t('bankImport.formatCsv')}
              {' · '}
              {plural(parsed.transactions.length, 'bankImport.transactionsOne', 'bankImport.transactionsOther')}
            </p>
          </div>
          <button type="button" onClick={() => onStatement(null)} aria-label={t('bankImport.changeFile')} title={t('bankImport.changeFile')} className="h-11 w-11 -mr-3 sm:h-8 sm:w-8 sm:-mr-1 shrink-0 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors">
            <X size={16} />
          </button>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".xml,.csv,.txt,text/csv,text/xml,application/xml,text/plain"
        className="sr-only"
        tabIndex={-1}
        onChange={e => { const f = e.target.files?.[0]; if (f) void loadFile(f); e.target.value = '' }}
      />
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('bankImport.privacy')}</p>

      {warnings.length > 0 && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <p className="font-medium flex items-center gap-1.5"><AlertTriangle size={13} /> {t('bankImport.warningsTitle')}</p>
          <ul className="mt-1 space-y-0.5 list-disc pl-4">
            {(warningsOpen ? warnings : warnings.slice(0, MAX_WARNINGS)).map((w, i) => <li key={i}>{warningText(w, t)}</li>)}
            {!warningsOpen && warnings.length > MAX_WARNINGS && (
              <li className="list-none -ml-4">
                {plural(warnings.length - MAX_WARNINGS, 'bankImport.moreWarningsOne', 'bankImport.moreWarningsOther')}{' '}
                <button type="button" onClick={() => setWarningsOpen(true)} className="underline underline-offset-2">{t('bankImport.showAllWarnings')}</button>
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  )
}
