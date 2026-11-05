import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { today } from '@/lib/utils/document'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { username?: unknown; apiKey?: unknown; country?: unknown } | null
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { username, country } = body ?? {}
  if (typeof username !== 'string' || !username || typeof country !== 'string' || !country) {
    return NextResponse.json({ error: 'username and country are required' }, { status: 400 })
  }
  if (!/^[a-z]{2}$/.test(country)) {
    return NextResponse.json({ error: 'Invalid country' }, { status: 400 })
  }

  let apiKey = typeof body?.apiKey === 'string' ? body.apiKey : ''
  if (!apiKey) {
    const { data: settings } = await supabase.from('settings').select('bookamat_api_key').single()
    apiKey = settings?.bookamat_api_key ?? ''
  }
  if (!apiKey) {
    return NextResponse.json({ error: 'apiKey is required' }, { status: 400 })
  }

  const year = Number(today().slice(0, 4))
  const base = `https://www.bookamat.com/api/v1/${country}/${year}/`
  const authHeader = `ApiKey ${username}:${apiKey}`

  try {
    const [bankRes, costRes, vatRes] = await Promise.all([
      fetch(`${base}preferences/bankaccounts/?format=json`, { headers: { Authorization: authHeader } }),
      fetch(`${base}preferences/costaccounts/?format=json`, { headers: { Authorization: authHeader } }),
      fetch(`${base}preferences/purchasetaxaccounts/?format=json`, { headers: { Authorization: authHeader } }),
    ])

    if (!bankRes.ok || !costRes.ok || !vatRes.ok) {
      const errRes = !bankRes.ok ? bankRes : !costRes.ok ? costRes : vatRes
      const text = await errRes.text()
      return NextResponse.json({ error: text }, { status: 400 })
    }

    const [bankData, costData, vatData] = await Promise.all([
      bankRes.json(),
      costRes.json(),
      vatRes.json(),
    ])

    function toArray(data: unknown): { id: number; title: string }[] {
      let arr: unknown[] = []
      if (Array.isArray(data)) {
        arr = data
      } else if (data && typeof data === 'object') {
        const d = data as Record<string, unknown>
        if (Array.isArray(d.objects)) arr = d.objects
        else if (Array.isArray(d.results)) arr = d.results
        else if (Array.isArray(d.data)) arr = d.data
        else {
          for (const v of Object.values(d)) {
            if (Array.isArray(v)) { arr = v; break }
          }
        }
      }
      return arr
        .map((item: unknown) => {
          if (!item || typeof item !== 'object') return null
          const o = item as Record<string, unknown>
          const id = Number(o.id ?? o.pk ?? 0)
          const title = String(o.title ?? o.name ?? o.description ?? o.label ?? o.bezeichnung ?? id)
          return { id, title }
        })
        .filter((x): x is { id: number; title: string } => x !== null && x.id !== 0)
    }

    return NextResponse.json({
      bankAccounts: toArray(bankData),
      costAccounts: toArray(costData),
      vatAccounts: toArray(vatData),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
