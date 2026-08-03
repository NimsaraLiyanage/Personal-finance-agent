// Account shapes and constants, with no imports.
//
// Split out of accounts.ts because the panel and the entry form are Client
// Components: importing a type from a module that also touches Prisma drags the
// database driver into the browser bundle. Values live here, behaviour lives
// next door.

export type AccountKind = 'cash' | 'bank' | 'card' | 'wallet';

export const ACCOUNT_KINDS: Array<{ value: AccountKind; label: string }> = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank account' },
  { value: 'card', label: 'Card' },
  { value: 'wallet', label: 'Mobile wallet' },
];

/** Category written on both halves of a transfer. Never a user category. */
export const TRANSFER_CATEGORY = 'transfer';

export interface AccountOption {
  id: string;
  name: string;
  kind: AccountKind;
  last4: string | null;
  isDefault: boolean;
}

export interface AccountBalance extends AccountOption {
  openingBalanceMinor: number;
  balanceMinor: number;
  formattedBalance: string;
  /** Rows on this account, so an untouched account can say so. */
  entryCount: number;
}
