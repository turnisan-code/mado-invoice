import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body?.ids?.length || !body.status) {
    return NextResponse.json({ error: 'ids and status required' }, { status: 400 })
  }

  const allowedStatuses = ['draft', 'sent', 'paid', 'overdue', 'cancelled']
  if (!allowedStatuses.includes(body.status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  // Issued statuses require a number; drafts get one assigned (sequentially) before the status change.
  if (['sent', 'paid', 'overdue'].includes(body.status)) {
    const { data: unnumbered, error: lookupErr } = await supabase
      .from('documents')
      .select('id')
      .in('id', body.ids)
      .eq('type', 'invoice')
      .is('number', null)
    if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 })
    for (const d of unnumbered ?? []) {
      const { error: issueErr } = await supabase.rpc('issue_document', { p_document_id: d.id })
      if (issueErr) return NextResponse.json({ error: issueErr.message }, { status: 500 })
    }
  }

  const { error } = await supabase
    .from('documents')
    .update({ status: body.status })
    .in('id', body.ids)
    .eq('type', 'invoice')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ updated: body.ids.length })
}

export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body?.ids?.length) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 })
  }

  const { error } = await supabase
    .from('documents')
    .delete()
    .in('id', body.ids)
    .eq('type', 'invoice')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ deleted: body.ids.length })
}
