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
