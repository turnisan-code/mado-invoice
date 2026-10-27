import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isUiLang } from '@/lib/i18n'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const lang = (body as { lang?: unknown }).lang
  if (!isUiLang(lang)) return NextResponse.json({ error: 'Invalid language' }, { status: 400 })

  const { data: settings } = await supabase.from('settings').select('id').single()
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 })

  const { error } = await supabase.from('settings').update({ ui_language: lang }).eq('id', settings.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ lang })
}
