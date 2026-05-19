'use client'

import { useState } from 'react'
import { Pencil, Mail, Phone, MapPin, Building2 } from 'lucide-react'
import ClientForm from '@/components/forms/ClientForm'
import type { Client } from '@/types'

const taxLabel: Record<string, string> = {
  at_vat: 'AT VAT (20%)',
  eu_reverse_charge: 'EU Reverse Charge',
  non_eu: 'Non-EU',
}

export default function ClientEditSection({ client }: { client: Client }) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return <ClientForm client={client} onSaved={() => setEditing(false)} />
  }

  const address = [
    client.address_line1,
    client.address_line2,
    [client.zip, client.city].filter(Boolean).join(' '),
    client.country,
  ].filter(Boolean).join(', ')

  return (
    <div className="space-y-0">
      {/* Card header */}
      <div className="flex items-center justify-between mb-5">
        <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Details</p>
        <button
          onClick={() => setEditing(true)}
          className="flex items-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors px-2 py-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <Pencil size={11} /> Edit
        </button>
      </div>

      {/* Contact */}
      <div className="space-y-2.5">
        {client.email && (
          <a href={`mailto:${client.email}`} className="flex items-center gap-3 text-sm text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors group min-w-0">
            <span className="p-1.5 rounded-md bg-neutral-100 dark:bg-neutral-800 shrink-0"><Mail size={12} className="text-neutral-500 dark:text-neutral-400" /></span>
            <span className="truncate">{client.email}</span>
          </a>
        )}
        {client.phone && (
          <a href={`tel:${client.phone}`} className="flex items-center gap-3 text-sm text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors">
            <span className="p-1.5 rounded-md bg-neutral-100 dark:bg-neutral-800 shrink-0"><Phone size={12} className="text-neutral-500 dark:text-neutral-400" /></span>
            {client.phone}
          </a>
        )}
        {address && (
          <div className="flex items-start gap-3 text-sm text-neutral-600 dark:text-neutral-400">
            <span className="p-1.5 rounded-md bg-neutral-100 dark:bg-neutral-800 shrink-0 mt-0.5"><MapPin size={12} className="text-neutral-500 dark:text-neutral-400" /></span>
            <span className="leading-snug">{address}</span>
          </div>
        )}
        {client.uid_number && (
          <div className="flex items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400">
            <span className="p-1.5 rounded-md bg-neutral-100 dark:bg-neutral-800 shrink-0"><Building2 size={12} className="text-neutral-500 dark:text-neutral-400" /></span>
            {client.uid_number}
          </div>
        )}
      </div>

      {/* Billing settings */}
      <div className="grid grid-cols-3 gap-3 mt-5 pt-4 border-t border-neutral-100 dark:border-neutral-800">
        <Stat label="Tax" value={taxLabel[client.tax_treatment] ?? client.tax_treatment} />
        <Stat label="Currency" value={client.currency ?? 'EUR'} />
        <Stat label="Payment" value={`${client.payment_days ?? 14}d`} />
      </div>

      {/* Language */}
      <div className="mt-3 pt-3 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
        <span className="text-xs text-neutral-400 dark:text-neutral-500">Language</span>
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{client.language === 'en' ? 'English' : 'Deutsch'}</span>
      </div>

      {/* Notes */}
      {client.notes && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-4 pt-4 border-t border-neutral-100 dark:border-neutral-800">{client.notes}</p>
      )}

      {/* Tags */}
      {client.tags?.length > 0 && (
        <div className="flex gap-1.5 flex-wrap mt-4 pt-4 border-t border-neutral-100 dark:border-neutral-800">
          {client.tags.map((t: string) => (
            <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">{t}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-neutral-400 dark:text-neutral-500 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">{value}</p>
    </div>
  )
}
