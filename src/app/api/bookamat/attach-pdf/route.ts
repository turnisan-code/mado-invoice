import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json()
    const { bookingId, pdfBase64, filename, country, year } = body

    const { data: settings } = await supabase
      .from('settings')
      .select('bookamat_username, bookamat_api_key')
      .single()

    if (!settings?.bookamat_username || !settings?.bookamat_api_key) {
      return NextResponse.json({ error: 'Bookamat not configured' }, { status: 400 })
    }

    const authHeader = `ApiKey ${settings.bookamat_username}:${settings.bookamat_api_key}`
    const baseUrl = `https://www.bookamat.com/api/v1/${country}/${year}/`

    // Strip data URL prefix and decode base64
    const base64Data = pdfBase64.replace(/^data:application\/pdf;base64,/, '')
    const pdfBytes = Uint8Array.from(Buffer.from(base64Data, 'base64'))

    const url = `${baseUrl}bookings/${bookingId}/documents/`
    console.log('[bookamat/attach-pdf] POST', url, 'bytes:', pdfBytes.length)

    // Try 'document' field name first (Bookamat convention), fallback to 'file'
    const formData = new FormData()
    formData.append(
      'document',
      new Blob([pdfBytes], { type: 'application/pdf' }),
      filename,
    )

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: authHeader },
      body: formData,
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
