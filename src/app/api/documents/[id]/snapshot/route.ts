import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const MAX_PDF_BYTES = 10 * 1024 * 1024

// Supabase Storage rejects keys outside this character set; a slash would also nest a folder.
function storageKey(date: string, number: string) {
  return `${date.slice(0, 4)}/${number.replace(/[^\w!.*'() &$@=;:+,?-]/g, '_')}.pdf`
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let payload: { pdfBase64?: unknown } | null
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const pdfBase64 = payload?.pdfBase64
  if (typeof pdfBase64 !== 'string' || !pdfBase64) {
    return NextResponse.json({ error: 'pdfBase64 is required' }, { status: 400 })
  }
  if (pdfBase64.length * 3 / 4 > MAX_PDF_BYTES) {
    return NextResponse.json({ error: 'PDF exceeds 10 MB' }, { status: 413 })
  }
  const pdf = Buffer.from(pdfBase64, 'base64')
  if (pdf.length > MAX_PDF_BYTES) return NextResponse.json({ error: 'PDF exceeds 10 MB' }, { status: 413 })
  if (pdf.subarray(0, 4).toString('latin1') !== '%PDF') {
    return NextResponse.json({ error: 'Not a PDF' }, { status: 400 })
  }

  const { data: doc } = await supabase.from('documents').select('id, number, date').eq('id', id).single()
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 400 })
  if (!doc.number) return NextResponse.json({ error: 'Only issued documents can be archived' }, { status: 400 })

  const path = storageKey(doc.date, doc.number)
  const { error: uploadErr } = await supabase.storage
    .from('documents')
    .upload(path, pdf, { upsert: true, contentType: 'application/pdf' })
  if (uploadErr) return NextResponse.json({ error: uploadErr.message }, { status: 500 })

  const { error: updateErr } = await supabase.from('documents').update({ pdf_path: path }).eq('id', id)
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  return NextResponse.json({ path })
}
