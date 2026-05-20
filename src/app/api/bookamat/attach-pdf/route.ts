import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { bookingId: string | number; pdfBase64: string; filename: string; country: string; year: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { bookingId, pdfBase64, filename, country, year } = body

  const { data: settings } = await supabase.from('settings').select('bookamat_username, bookamat_api_key').single()
  if (!settings?.bookamat_username || !settings?.bookamat_api_key) {
    return NextResponse.json({ error: 'Bookamat not configured' }, { status: 400 })
  }

  const authHeader = `ApiKey ${settings.bookamat_username}:${settings.bookamat_api_key}`
  const baseUrl = `https://www.bookamat.com/api/v1/${country}/${year}/`

  const pdfBytes = Buffer.from(pdfBase64.replace(/^data:application\/pdf;base64,/, ''), 'base64')

  const formData = new FormData()
  formData.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), filename)

  const res = await fetch(`${baseUrl}bookings/${bookingId}/documents/`, {
    method: 'POST',
    headers: { Authorization: authHeader },
    body: formData,
  })

  const text = await res.text()
  if (!res.ok) {
    console.log(`[bookamat/attach-pdf] ${res.status}:`, text)
    return NextResponse.json({ error: `${res.status}: ${text}` }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
