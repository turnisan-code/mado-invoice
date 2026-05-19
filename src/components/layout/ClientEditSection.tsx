'use client'

import { useState } from 'react'
import { Pencil } from 'lucide-react'
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

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Field label="Name" value={client.name} />
        {client.company && <Field label="Company" value={client.company} />}
        {client.email && <Field label="Email" value={client.email} />}
        {client.phone && <Field label="Phone" value={client.phone} />}
        {client.address_line1 && (
          <Field label="Address" value={[client.address_line1, client.address_line2, `${client.zip ?? ''} ${client.city ?? ''}`.trim(), client.country].filter(Boolean).join(', ')} />
        )}
        {client.uid_number && <Field label="UID" value={client.uid_number} />}
        <Field label="Tax" value={taxLabel[client.tax_treatment] ?? client.tax_treatment} />
        <Field label="Currency" value={client.currency ?? 'EUR'} />
        <Field label="Payment days" value={String(client.payment_days ?? 14)} />
        {client.language && <Field label="Language" value={client.language === 'de' ? 'Deutsch' : 'English'} />}
        {client.notes && <Field label="Notes" value={client.notes} className="col-span-2" />}
      </div>
      {client.tags?.length > 0 && (
        <div className="flex gap-1.5 flex-wrap pt-1">
          {client.tags.map((t: string) => (
            <span key={t} className="text-xs px-2 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">{t}</span>
          ))}
        </div>
      )}
      <button
        onClick={() => setEditing(true)}
        className="flex items-center gap-1.5 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors mt-2"
      >
        <Pencil size={13} /> Edit details
      </button>
    </div>
  )
}

function Field({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <p className="text-xs text-neutral-400 dark:text-neutral-500">{label}</p>
      <p className="text-neutral-800 dark:text-neutral-200">{value}</p>
    </div>
  )
}
