// The bookamat Zahlungsmittelkonto of the bank the CSV comes from. Every import
// row is a movement on that one account, so the account is a fact of the file,
// not something for the AI to guess. It is picked by the bank's name, never by
// list order: bookamat lists „Geschäftskonto - Musterbank“ before „Geschäftskonto
// - Easybank“, and the old /easybank|geschäftskonto/ test put every AI-classified
// and every income row on Musterbank.
//
// 0 when no account names the bank. The row then shows „— auswählen —“ and
// bookamat refuses it, instead of booking it to a guessed account.
export function csvBankAccountId(bankAccounts?: { id: number; name: string }[] | null): number {
  return (bankAccounts ?? []).find(a => /easybank/i.test(a.name))?.id ?? 0
}

// Mado: the Zahlungsmittelkonto of the statement's own account (easybank's column 0), by its
// IBAN as bookamat keeps it; else, as Bookmatic did, the one named after the bank. 0 when
// neither names one.
export function statementBankAccountId(
  bankAccounts: { id: number; name: string; iban?: string | null }[] | null | undefined,
  statementIban: string | null | undefined,
): number {
  const norm = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, '').toUpperCase()
  const iban = norm(statementIban)
  const byIban = iban ? (bankAccounts ?? []).filter(a => norm(a.iban) === iban) : []
  return byIban.length === 1 ? byIban[0].id : csvBankAccountId(bankAccounts)
}
