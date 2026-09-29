import type { ResellerBankAccount } from '@prisma/client'
import { decryptSecret, encryptSecret } from '../../utils/crypto'

export function encryptAccountNumber(accountNumber: string) {
  return { accountNumberEncrypted: encryptSecret(accountNumber), accountNumberLast4: accountNumber.slice(-4) }
}

export function decryptAccountNumber(account: Pick<ResellerBankAccount, 'accountNumberEncrypted'>): string {
  return decryptSecret(account.accountNumberEncrypted)
}

/** Safe representation for API responses. Never includes the encrypted value. */
export function maskedBankAccount(account: ResellerBankAccount | null) {
  if (!account) return null
  return {
    bankName: account.bankName,
    branch: account.branch,
    accountHolderName: account.accountHolderName,
    accountNumberMasked: `•••• •••• ${account.accountNumberLast4}`,
    accountNumberLast4: account.accountNumberLast4,
  }
}
