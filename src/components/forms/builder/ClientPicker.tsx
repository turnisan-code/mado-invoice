'use client'

import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { fieldClass } from '@/components/ui/control'
import { clientLabel } from '@/lib/utils/clients'
import { useT } from '@/lib/i18n/client'
import type { Client, ClientStatus } from '@/types'

const CLIENT_GROUPS: ClientStatus[] = ['active', 'lead', 'inactive']

// Searchable client combobox: active clients first, then leads, then inactive ones; the last
// entry creates a new client from what was typed.
export function ClientPicker({ id, clients, value, onChange, onCreate, invalid, disabled, describedBy }: {
  id: string
  clients: Client[]
  value: string
  onChange: (id: string) => void
  onCreate: (name: string) => void
  invalid?: boolean
  disabled?: boolean
  describedBy?: string
}) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const listId = `${id}-list`
  const sorted = useMemo(() => [...clients].sort((a, b) => clientLabel(a).localeCompare(clientLabel(b))), [clients])
  const selected = clients.find(c => c.id === value) ?? null
  const q = query.trim().toLowerCase()
  const groups = CLIENT_GROUPS
    .map(status => ({
      status,
      items: sorted.filter(c => (c.status ?? 'active') === status
        && (!q || [clientLabel(c), c.client_number, c.email].some(s => s?.toLowerCase().includes(q)))),
    }))
    .filter(g => g.items.length > 0)
  const options = groups.flatMap(g => g.items)
  // The "new client" entry follows the clients.
  const createIndex = options.length
  const active = open ? options[highlight] : undefined
  const createActive = open && highlight === createIndex

  function close() { setOpen(false); setQuery('') }
  function pick(c: Client) { onChange(c.id); close() }
  function create() { const name = query.trim(); close(); onCreate(name) }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHighlight(0) }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, createIndex)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter' && active) { e.preventDefault(); pick(active) }
    else if (e.key === 'Enter' && createActive) { e.preventDefault(); create() }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  return (
    <div className="relative" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close() }}>
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={active ? `${listId}-${active.id}` : createActive ? `${listId}-new` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        value={open ? query : clientLabel(selected)}
        placeholder={open ? t('issueChecks.searchClients') : t('builder.selectClientPlaceholder')}
        onFocus={() => { setOpen(true); setHighlight(0) }}
        onClick={() => setOpen(true)}
        onChange={e => { setQuery(e.target.value); setOpen(true); setHighlight(0) }}
        onKeyDown={onKeyDown}
        className={fieldClass}
      />
      {open && !disabled && (
        <div id={listId} role="listbox" aria-label={t('builder.client')}
          className="absolute z-30 left-0 right-0 mt-1 max-h-72 overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg py-1">
          {groups.map(g => (
            <div key={g.status} role="group" aria-labelledby={`${listId}-${g.status}`}>
              <p id={`${listId}-${g.status}`} className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                {t(`status.${g.status}`)}
              </p>
              {g.items.map(c => {
                const i = options.indexOf(c)
                return (
                  <button
                    key={c.id}
                    id={`${listId}-${c.id}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={c.id === value}
                    onMouseDown={e => e.preventDefault()}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => pick(c)}
                    className={`w-full text-left px-3 py-2.5 sm:py-2 text-sm flex items-center justify-between gap-3 ${i === highlight ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'} ${c.id === value ? 'font-medium' : ''}`}
                  >
                    <span className="min-w-0 truncate">{clientLabel(c)}</span>
                    {c.client_number && <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0">{c.client_number}</span>}
                  </button>
                )
              })}
            </div>
          ))}
          {options.length === 0 && (
            <p className="px-3 py-4 text-xs text-neutral-500 dark:text-neutral-400 text-center">{t('issueChecks.noClients')}</p>
          )}
          <button
            id={`${listId}-new`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={false}
            onMouseDown={e => e.preventDefault()}
            onMouseEnter={() => setHighlight(createIndex)}
            onClick={create}
            className={`w-full text-left px-3 py-2.5 sm:py-2 text-sm flex items-center gap-1.5 border-t border-neutral-100 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300 ${createActive ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}
          >
            <Plus size={13} aria-hidden="true" />
            <span className="min-w-0 truncate">{q ? t('editor.client.newNamed', { name: query.trim() }) : t('editor.client.new')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
