import type { SupabaseClient } from '@supabase/supabase-js'

export async function markOverdueInvoices(supabase: SupabaseClient) {
  const today = new Date().toISOString().split('T')[0]
  await supabase
    .from('documents')
    .update({ status: 'overdue' })
    .eq('type', 'invoice')
    .eq('status', 'sent')
    .lt('due_date', today)
    .not('due_date', 'is', null)
}
