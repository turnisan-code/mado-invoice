import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { username: string; apiKey: string; country: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { username, apiKey, country } = body
  if (!username || !apiKey || !country) {
    return NextResponse.json({ error: 'username, apiKey and country are required' }, { status: 400 })
  }

  const year = new Date().getFullYear()
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

    const bankAccounts: { id: number; title: string }[] = bankData.objects ?? bankData
    const costAccounts: { id: number; title: string }[] = costData.objects ?? costData
    const vatAccounts: { id: number; title: string }[] = vatData.objects ?? vatData

    return NextResponse.json({ bankAccounts, costAccounts, vatAccounts })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
