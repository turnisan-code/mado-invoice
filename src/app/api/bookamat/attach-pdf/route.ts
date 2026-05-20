import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const payload = await req.json()
    const { bookingId, pdfBase64, filename, country, year } = payload

    const { data: settings } = await supabase
      .from('settings')
      .select('bookamat_username, bookamat_api_key')
      .single()

    if (!settings?.bookamat_username || !settings?.bookamat_api_key) {
      return NextResponse.json({ error: 'Bookamat not configured' }, { status: 400 })
    }

    const authHeader = `ApiKey ${settings.bookamat_username}:${settings.bookamat_api_key}`
    const baseUrl = `https://www.bookamat.com/api/v1/${country}/${year}/`

    // Strip data URL prefix — keep raw base64 string (Bookamat expects base64 JSON, not multipart)
    const base64Data = pdfBase64.replace(/^data:[^;]+;base64,/, '')

    // Bookamat: POST /bookings/attachments/ with JSON { booking, name, file }
    // See: bookamat.com/dokumentation/api/v1/attachments_bookings.html
    const url = `${baseUrl}bookings/attachments/`
    const safeName = filename.replace(/"/g, '').slice(0, 50)
    console.log('[bookamat/attach-pdf] POST', url, 'name:', safeName, 'base64 len:', base64Data.length)

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        booking: Number(bookingId),
        name: safeName,
        file: base64Data,
      }),
    })

    const text = await res.text()
    console.log(`[bookamat/attach-pdf] ${res.status}:`, text.slice(0, 500))

    if (!res.ok) {
      return NextResponse.json({ error: `Bookamat ${res.status}: ${text}` }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log('[bookamat/attach-pdf] crash:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
