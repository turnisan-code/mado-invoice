import type { SupabaseClient } from '@supabase/supabase-js'
import { today } from '@/lib/utils/document'

export async function markOverdueInvoices(supabase: SupabaseClient) {
  await supabase
    .from('documents')
    .update({ status: 'overdue' })
    .eq('type', 'invoice')
    .eq('status', 'sent')
    .lt('due_date', today())
    .not('due_date', 'is', null)
}
