// The made-up owner every expense test runs as (Mado sets the real one from Einstellungen).
// Imported first by each test file.
import { setExpenseOwner, type ExpenseOwner } from '../owner'

export const TEST_OWNER: ExpenseOwner = { name: 'Konrad Testmann', vatin: 'ATU12345675', businessIbans: ['AT990000000000000777'] }

setExpenseOwner(TEST_OWNER)
