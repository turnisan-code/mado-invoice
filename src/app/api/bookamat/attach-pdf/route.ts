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

    // Strip data URL prefix and decode base64
    const base64Data = pdfBase64.replace(/^data:application\/pdf;base64,/, '')
    const pdfBuffer = Buffer.from(base64Data, 'base64')

    const url = `${baseUrl}bookings/${bookingId}/documents/`
    console.log('[bookamat/attach-pdf] POST', url, 'bytes:', pdfBuffer.length)

    // Build multipart body manually — avoids undici FormData/Blob streaming bugs
    // that cause "terminated" errors in Node.js serverless environments
    const boundary = `----StudioInvoiceBoundary${Date.now().toString(36)}`
    const safeFilename = filename.replace(/"/g, '')
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="document"; filename="${safeFilename}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`
    )
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`)
    const body = Buffer.concat([preamble, pdfBuffer, epilogue])

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
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
