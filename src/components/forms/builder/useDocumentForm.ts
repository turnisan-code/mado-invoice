'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { addDays, today } from '@/lib/utils/document'
import { FLUSH_EDITS_EVENT, type FlushEditsDetail } from '@/lib/issued-pdf'
import { useT } from '@/lib/i18n/client'
import type { Client, DocumentType } from '@/types'
import type { PublicSettings } from '@/lib/public-settings'
import {
  AUTOSAVE_DELAY, PATHS, contentKeyOf, docFields, initialForm, itemsPayload, savedKeyOf, storedKeyOf, termDays,
  type EditorDocument, type FormState, type LineItem,
} from './model'
import { BUYER_REFERENCE_EVENT, ISSUE_DATE_EVENT, type BuyerReferenceDetail, type IssueDateDetail } from './events'

// Unsaved edits kept on this device per document ('new' until the draft exists). `base` is the
// saved key the edits started from: a server copy that moved on since then is newer. It is null
// until the draft and its items were first saved.
export interface Backup { savedAt: number; base: string | null; form: FormState }

function readBackup(key: string): Backup | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const b = JSON.parse(raw) as Partial<Backup> | null
    if (!b || typeof b.savedAt !== 'number' || !b.form || !Array.isArray(b.form.lines)) return null
    return { savedAt: b.savedAt, base: typeof b.base === 'string' ? b.base : null, form: b.form }
  } catch {
    return null
  }
}

function writeBackup(key: string, backup: Backup) {
  try { window.localStorage.setItem(key, JSON.stringify(backup)) } catch { /* storage full or blocked */ }
}

function removeBackup(key: string) {
  try { window.localStorage.removeItem(key) } catch { /* storage blocked */ }
}

export function errorMessage(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback
}

export type PersistMode = 'auto' | 'save' | 'issue'

interface Options {
  type: DocumentType
  settings: PublicSettings
  // Every client the editor knows, including ones added from the picker.
  clients: Client[]
  doc?: EditorDocument
  defaultClientId?: string
}

// The editor's form state and the one write path for it: autosave, Save draft, issuing and the
// flush on leaving all go through persist(); every edit is backed up on the device at once.
export function useDocumentForm({ type, settings, clients, doc, defaultClientId }: Options) {
  const router = useRouter()
  const supabase = createClient()
  const { t } = useT()

  const [form, setForm] = useState<FormState>(() => initialForm(type, settings, clients, doc, defaultClientId))
  const [saving, setSaving] = useState(false)
  const [autoSaving, setAutoSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [docId, setDocId] = useState<string | null>(doc?.id ?? null)
  const [restoreOffer, setRestoreOffer] = useState<Backup | null>(null)

  const formKey = savedKeyOf(type, form)
  const contentKey = contentKeyOf(form)
  const [initialKeys] = useState(() => ({ saved: formKey, content: contentKey }))

  const formRef = useRef(form)
  const docIdRef = useRef<string | null>(doc?.id ?? null)
  const savedKeyRef = useRef(initialKeys.saved)
  // The document date the database holds; an autosave never replaces it with an empty field.
  const storedDateRef = useRef<string | null>(doc?.date ?? null)
  // False from inserting a new draft until its items are written too.
  const savedOnceRef = useRef(!!doc)
  // Mounted without a document at a document's URL (see the restore effect): never insert one.
  const misplacedRef = useRef(false)
  const saveErrorRef = useRef<string | null>(null)
  const pendingWritesRef = useRef(0)
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writeChain = useRef<Promise<void>>(Promise.resolve())
  const issuingRef = useRef(false)
  const mountedRef = useRef(false)
  const offerPendingRef = useRef(false)

  const patch = (p: Partial<FormState>) => setForm(f => ({ ...f, ...p }))
  const setLines = (fn: (lines: LineItem[]) => LineItem[]) => setForm(f => ({ ...f, lines: fn(f.lines) }))
  const updateLine = (id: string, p: Partial<LineItem>) => setLines(ls => ls.map(l => l.id === id ? { ...l, ...p } : l))

  const backupKey = (id: string | null) => `mado-invoice:unsaved:${type}:${id ?? 'new'}`

  // A new document has unsaved work once something beyond the client was entered.
  function isDirty(f: FormState) {
    return docIdRef.current ? storedKeyOf(type, f, storedDateRef.current) !== savedKeyRef.current : contentKeyOf(f) !== initialKeys.content
  }

  function canPersist(f: FormState) {
    return !misplacedRef.current && !!f.clientId && (!!docIdRef.current || contentKeyOf(f) !== initialKeys.content)
  }

  // A backup taken before the draft's first complete save has no base: the server copy may lack
  // the items, so it is offered whenever it differs.
  function backupNow() {
    const f = formRef.current
    if (!isDirty(f)) return
    const base = docIdRef.current && savedOnceRef.current ? savedKeyRef.current : null
    writeBackup(backupKey(docIdRef.current), { savedAt: Date.now(), base, form: f })
  }

  function cancelAutoSave() {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current)
      autoSaveTimer.current = null
    }
  }

  // Runs writes strictly one after another so an autosave can never interleave with an explicit save.
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = writeChain.current.then(fn, fn)
    writeChain.current = run.then(() => undefined, () => undefined)
    return run
  }

  // The first write of a new document creates the draft; the address bar then shows its own URL
  // without leaving the editor, so a reload or Back finds the draft instead of an empty form.
  function adoptId(id: string) {
    docIdRef.current = id
    setDocId(id)
    removeBackup(backupKey(null))
    backupNow()
    const newPath = `/${PATHS[type]}/new`
    if (mountedRef.current && window.location.pathname === newPath) window.history.replaceState(null, '', `/${PATHS[type]}/${id}`)
  }

  // The one write path: header + items of `f`, inserting the draft once for a new document.
  // Throws on failure; returns the document id. An autosave never writes an empty document date
  // over the stored one: the field is empty from clearing it until a new date is complete.
  async function persist(f: FormState, mode: PersistMode = 'auto'): Promise<string> {
    const effectiveDate = f.date || today()
    const c = clients.find(x => x.id === f.clientId)
    const effective: FormState = {
      ...f,
      date: effectiveDate,
      dueDate: f.dueDate || (mode === 'issue' && c ? addDays(effectiveDate, termDays(type, settings, c)) : ''),
    }
    const fields = docFields(type, effective)
    const items = itemsPayload(effective.lines)
    pendingWritesRef.current++
    try {
      let id = docIdRef.current
      if (id) {
        const keepStoredDate = mode === 'auto' && !f.date
        const update: Partial<typeof fields> = { ...fields }
        if (keepStoredDate) delete update.date
        const { error } = await supabase.from('documents').update(update).eq('id', id)
        if (error) throw new Error(error.message)
        if (!keepStoredDate) storedDateRef.current = fields.date
      } else {
        if (misplacedRef.current) throw new Error(t('common.unknownError'))
        if (!fields.client_id) throw new Error(t('builder.selectClient'))
        const { data, error } = await supabase.from('documents')
          .insert({ type, number: null, status: 'draft', exchange_rate: 1, ...fields })
          .select('id').single()
        if (error) throw new Error(error.message)
        id = data.id as string
        storedDateRef.current = fields.date
        adoptId(id)
      }
      const { error: itemsErr } = await supabase.rpc('replace_document_items', { p_document_id: id, p_items: items })
      if (itemsErr) throw new Error(t('builder.itemsError', { error: itemsErr.message }))

      // A cleared date counts as saved: the stored one stays until a new date is entered.
      savedKeyRef.current = JSON.stringify([{ ...fields, date: storedDateRef.current ?? fields.date }, items])
      savedOnceRef.current = true
      // Saving or issuing shows the date and due date that were filled in, and keeps the snapshot
      // in step so the next flush does not write the empty values back. An autosave leaves the
      // fields alone: a date input is empty while it is being typed in.
      if (mode !== 'auto' && (effective.date !== f.date || effective.dueDate !== f.dueDate)) {
        const cur = formRef.current
        formRef.current = { ...cur, date: cur.date || effective.date, dueDate: cur.dueDate || effective.dueDate }
        setForm(s => ({ ...s, date: s.date || effective.date, dueDate: s.dueDate || effective.dueDate }))
      }
      saveErrorRef.current = null
      setSaveError(null)
      setLastSaved(new Date())
      // Edits made while this was being written stay backed up, now against what was saved.
      if (isDirty(formRef.current)) backupNow()
      else removeBackup(backupKey(id))
      return id
    } finally {
      pendingWritesRef.current--
    }
  }

  // Writes pending edits now (autosave timer, leaving the page, the status menu, Cmd+S).
  // Resolves once everything queued so far is written.
  function flush(): Promise<void> {
    cancelAutoSave()
    if (issuingRef.current || !isDirty(formRef.current) || !canPersist(formRef.current)) return writeChain.current
    setAutoSaving(true)
    return serialized(async () => {
      const latest = formRef.current
      if (!isDirty(latest) || !canPersist(latest)) return
      await persist(latest)
    })
      .catch(e => {
        const msg = errorMessage(e, t('common.unknownError'))
        if (!saveErrorRef.current) toast.error(t('builder.notSavedToast', { error: msg }))
        saveErrorRef.current = msg
        setSaveError(msg)
      })
      .finally(() => setAutoSaving(false))
  }

  async function saveDraft() {
    if (!formRef.current.clientId) { toast.error(t('builder.selectClient')); return }
    cancelAutoSave()
    setSaving(true)
    try {
      const id = await serialized(() => persist(formRef.current, 'save'))
      toast.success(t('builder.draftSaved'))
      if (!doc) router.replace(`/${PATHS[type]}/${id}`)
      else router.refresh()
    } catch (e) {
      toast.error(errorMessage(e, t('common.unknownError')))
    } finally {
      setSaving(false)
    }
  }

  function restoreBackup() {
    if (!restoreOffer) return
    const f: FormState = { ...formRef.current, ...restoreOffer.form, currency: form.currency }
    setForm({ ...f, lines: f.lines.map(l => ({ ...l, service_date_end: l.service_date_end ?? null })) })
    offerPendingRef.current = false
    setRestoreOffer(null)
    toast.success(t('issueChecks.restored'))
  }

  function discardBackup() {
    offerPendingRef.current = false
    setRestoreOffer(null)
    // Edits made since opening are the backup now; only an untouched form drops it.
    if (!isDirty(formRef.current)) removeBackup(backupKey(docIdRef.current))
  }

  // The issue dialog's choices (today's date, the due date that follows) go into the snapshot and
  // the fields before anything is written, so the server renders exactly these values.
  function applyOverrides(o: Partial<FormState>) {
    formRef.current = { ...formRef.current, ...o }
    setForm(s => ({ ...s, ...o }))
  }

  // Listeners, timers and the actions that run after issuing call the latest render's functions
  // and read the latest form (the issue dialog may have changed the date since the click).
  const latest = useRef({ flush, saveDraft, isDirty, persist, serialized, applyOverrides, cancelAutoSave })
  useEffect(() => {
    formRef.current = form
    latest.current = { flush, saveDraft, isDirty, persist, serialized, applyOverrides, cancelAutoSave }
  })

  // An earlier visit left edits on this device that the server copy does not have.
  useEffect(() => {
    // Back to a draft that was created here can restore the empty editor it was started in (the
    // address bar switched to the draft without a navigation); load the draft itself instead.
    if (!doc && window.location.pathname !== `/${PATHS[type]}/new`) {
      misplacedRef.current = true
      router.replace(window.location.pathname + window.location.search)
      return
    }
    const key = backupKey(docIdRef.current)
    const b = readBackup(key)
    if (!b) return
    const merged = { ...formRef.current, ...b.form, currency: formRef.current.currency }
    const newer = docIdRef.current
      ? (b.base === null || b.base === initialKeys.saved) && storedKeyOf(type, merged, storedDateRef.current) !== initialKeys.saved
      : contentKeyOf(merged) !== initialKeys.content
    if (!newer) { removeBackup(key); return }
    offerPendingRef.current = true
    setRestoreOffer(b)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Every edit is backed up on the device at once and written to the server 2 s later. The date
  // is watched on its own: an empty one and today's give the same formKey.
  useEffect(() => {
    const f = formRef.current
    if (misplacedRef.current) return
    if (!latest.current.isDirty(f)) {
      if (!offerPendingRef.current) removeBackup(backupKey(docIdRef.current))
      return
    }
    backupNow()
    if (!canPersist(f)) return
    cancelAutoSave()
    autoSaveTimer.current = setTimeout(() => { autoSaveTimer.current = null; void latest.current.flush() }, AUTOSAVE_DELAY)
    return cancelAutoSave
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey, form.date])

  // Leaving never drops edits: hiding the tab, closing it and unmounting flush the autosave
  // instead of cancelling it, and closing with unsaved work asks first.
  useEffect(() => {
    mountedRef.current = true
    const flushNow = () => { void latest.current.flush() }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow() }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingWritesRef.current > 0 || latest.current.isDirty(formRef.current)) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flushNow)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      mountedRef.current = false
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flushNow)
      window.removeEventListener('beforeunload', onBeforeUnload)
      flushNow()
    }
  }, [])

  // The status menu issues this document from outside the builder; edits still waiting for the
  // autosave are written first, so the frozen PDF the server renders includes them. When its
  // issue dialog moves the date to today, the new dates are written from here.
  useEffect(() => {
    function onFlush(e: Event) {
      const { documentId, waitUntil } = (e as CustomEvent<FlushEditsDetail>).detail
      if (documentId !== docIdRef.current) return
      waitUntil(latest.current.flush())
    }
    function onIssueDate(e: Event) {
      const { documentId, date, dueDate, waitUntil } = (e as CustomEvent<IssueDateDetail>).detail
      if (documentId !== docIdRef.current) return
      const l = latest.current
      l.cancelAutoSave()
      l.applyOverrides(dueDate === undefined ? { date } : { date, dueDate })
      waitUntil(l.serialized(() => latest.current.persist(formRef.current)))
    }
    function onBuyerReference(e: Event) {
      const { documentId, buyerReference } = (e as CustomEvent<BuyerReferenceDetail>).detail
      if (documentId === docIdRef.current) setForm(f => ({ ...f, buyerReference }))
    }
    window.addEventListener(FLUSH_EDITS_EVENT, onFlush)
    window.addEventListener(ISSUE_DATE_EVENT, onIssueDate)
    window.addEventListener(BUYER_REFERENCE_EVENT, onBuyerReference)
    return () => {
      window.removeEventListener(FLUSH_EDITS_EVENT, onFlush)
      window.removeEventListener(ISSUE_DATE_EVENT, onIssueDate)
      window.removeEventListener(BUYER_REFERENCE_EVENT, onBuyerReference)
    }
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (docIdRef.current) void latest.current.flush()
        else void latest.current.saveDraft()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const needsClient = !docId && !form.clientId && contentKey !== initialKeys.content
  const saveStatus = saveError
    ? { text: t('builder.notSaved', { error: saveError }), cls: 'text-red-500' }
    : autoSaving ? { text: t('common.saving'), cls: '' }
    : needsClient ? { text: t('issueChecks.chooseClientToSave'), cls: 'text-amber-600 dark:text-amber-400' }
    : lastSaved ? { text: t('builder.saved', { time: lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }), cls: '' }
    : null

  return {
    form, formKey, patch, setLines, updateLine,
    docId, saving, setSaving, saveStatus,
    restoreOffer, restoreBackup, discardBackup,
    formRef, docIdRef, savedKeyRef, issuingRef,
    persist, flush, serialized, cancelAutoSave, saveDraft, applyOverrides,
  }
}
