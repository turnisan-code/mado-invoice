import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Plus, Search } from 'lucide-react'

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; tag?: string }>
}) {
  const { q, status, tag } = await searchParams
  const supabase = await createClient()

  let query = supabase
    .from('clients')
    .select('*')
    .order('name')

  if (status) query = query.eq('status', status)
  if (tag) query = query.contains('tags', [tag])

  const { data: clients } = await query

  const filtered = q
    ? clients?.filter(c =>
        `${c.name} ${c.company ?? ''} ${c.email}`.toLowerCase().includes(q.toLowerCase())
      )
    : clients

  const statusColor: Record<string, string> = {
    active: 'text-green-700 bg-green-100',
    inactive: 'text-neutral-500 bg-neutral-100',
    lead: 'text-amber-700 bg-amber-100',
  }

  const taxLabel: Record<string, string> = {
    at_vat: 'AT VAT',
    eu_reverse_charge: 'Reverse Charge',
    non_eu: 'Non-EU',
  }

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Clients</h1>
        <Link
          href="/clients/new"
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-neutral-900 text-white hover:bg-neutral-700 transition-colors"
        >
          <Plus size={14} /> New Client
        </Link>
      </div>

      <form className="flex gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            name="q"
            defaultValue={q}
            placeholder="Search name, company, email…"
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-neutral-200 rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-400 bg-white"
          />
        </div>
        <select
          name="status"
          defaultValue={status ?? ''}
          className="text-sm border border-neutral-200 rounded-md px-2 py-1.5 bg-white focus:outline-none"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="lead">Lead</option>
        </select>
        <button type="submit" className="text-sm px-3 py-1.5 rounded-md border border-neutral-200 hover:bg-neutral-50 transition-colors">
          Filter
        </button>
      </form>

      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-neutral-100 bg-neutral-50">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Name</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Company</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Country</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Tax</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Status</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Tags</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50">
            {(filtered?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-neutral-400">No clients found.</td>
              </tr>
            )}
            {filtered?.map(c => (
              <tr key={c.id} className="hover:bg-neutral-50 transition-colors cursor-pointer">
                <td className="px-4 py-3">
                  <Link href={`/clients/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                </td>
                <td className="px-4 py-3 text-neutral-500">{c.company ?? '—'}</td>
                <td className="px-4 py-3 text-neutral-500">{c.country}</td>
                <td className="px-4 py-3 text-neutral-500">{taxLabel[c.tax_treatment] ?? c.tax_treatment}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[c.status]}`}>
                    {c.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1 flex-wrap">
                    {c.tags.map((t: string) => (
                      <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-500">{t}</span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-400">{filtered?.length ?? 0} client{filtered?.length !== 1 ? 's' : ''}</p>
    </div>
  )
}
