import { redirect } from 'next/navigation'

// The bank import is the „Kontoauszug“ page now (PR 9a): one statement for the invoices'
// payments and the expenses.
export default function BankImportPage() {
  redirect('/bank')
}
