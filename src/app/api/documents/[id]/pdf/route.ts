import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: doc } = await supabase.from('documents').select('id, number, pdf_path').eq('id', id).single()
  if (!doc?.number || !doc.pdf_path) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: file, error } = await supabase.storage.from('documents').download(doc.pdf_path)
  if (error || !file) return NextResponse.json({ error: error?.message ?? 'Snapshot missing' }, { status: 404 })

  return new NextResponse(file, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${doc.number}.pdf"`,
    },
  })
}
