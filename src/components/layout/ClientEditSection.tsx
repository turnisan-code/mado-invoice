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
    <div className="space-y-5">
      {/* Contact */}
      <div className="space-y-2">
        {client.email && (
          <a href={`mailto:${client.email}`} className="flex items-center gap-2.5 text-sm text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors group min-w-0">
            <Mail size={14} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
            <span className="truncate">{client.email}</span>
          </a>
        )}
        {client.phone && (
          <a href={`tel:${client.phone}`} className="flex items-center gap-2.5 text-sm text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors">
            <Phone size={14} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
            {client.phone}
          </a>
        )}
        {address && (
          <div className="flex items-start gap-2.5 text-sm text-neutral-600 dark:text-neutral-400">
            <MapPin size={14} className="shrink-0 text-neutral-400 dark:text-neutral-500 mt-0.5" />
            <span>{address}</span>
          </div>
        )}
        {client.uid_number && (
          <div className="flex items-center gap-2.5 text-sm text-neutral-600 dark:text-neutral-400">
            <Building2 size={14} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
            {client.uid_number}
          </div>
        )}
      </div>

      {/* Billing settings */}
      <div className="grid grid-cols-3 gap-3 pt-1 border-t border-neutral-100 dark:border-neutral-800">
        <Stat label="Tax" value={taxLabel[client.tax_treatment] ?? client.tax_treatment} />
        <Stat label="Currency" value={client.currency ?? 'EUR'} />
        <Stat label="Payment" value={`${client.payment_days ?? 14} days`} />
      </div>

      {/* Notes */}
      {client.notes && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400 border-t border-neutral-100 dark:border-neutral-800 pt-3">{client.notes}</p>
      )}

      {/* Tags */}
      {client.tags?.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {client.tags.map((t: string) => (
            <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">{t}</span>
          ))}
        </div>
      )}

      <button
        onClick={() => setEditing(true)}
        className="flex items-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors border-t border-neutral-100 dark:border-neutral-800 pt-4 w-full"
      >
        <Pencil size={12} /> Edit details
      </button>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-neutral-400 dark:text-neutral-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{value}</p>
    </div>
  )
}
