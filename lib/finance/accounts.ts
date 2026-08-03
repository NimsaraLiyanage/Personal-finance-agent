// Accounts, balances, and moving money between them.
//
// Two rules hold this together and everything else follows from them:
//
//   1. A **balance** is the opening balance plus every row on that account.
//      Transfers included — moving money is exactly what changes a balance.
//   2. A **transfer** counts as neither income nor expense. It is two rows
//      sharing a `transferGroupId`, and every aggregate in queries.ts filters
//      them out. Taking Rs 5,000 from an ATM must not read as spending it, or
//      the month is overstated and then overstated again when the cash is used.
//
// The split matters: the same pair of rows is *in* a balance and *out of* a
// spending total. Getting that backwards is the classic personal-finance bug.

import { prisma } from '../db';
import { formatMoney } from '../money';
import { TRANSFER_CATEGORY, type AccountBalance, type AccountKind, type AccountOption } from './account-types';
import type { LedgerScope } from './queries';

// Re-exported so server callers have one import to reach for. Client Components
// must import from ./account-types directly — see the note in that file.
export {
  ACCOUNT_KINDS,
  TRANSFER_CATEGORY,
  type AccountBalance,
  type AccountKind,
  type AccountOption,
} from './account-types';

/**
 * Give a new user somewhere to put money.
 *
 * Exactly one account, called Cash, because that is the only account we can
 * assume without inventing something about their life. Everything else they
 * add themselves. Idempotent, so it is safe on a read path.
 */
export async function ensureAccounts(userId: string, currency: string): Promise<void> {
  const existing = await prisma.account.count({ where: { userId } });
  if (existing > 0) return;

  await prisma.account.createMany({
    data: [{ userId, name: 'Cash', kind: 'cash', currency, isDefault: true, sortOrder: 0 }],
    skipDuplicates: true,
  });
}

export async function listAccounts(userId: string, currency: string): Promise<AccountOption[]> {
  await ensureAccounts(userId, currency);
  const rows = await prisma.account.findMany({
    where: { userId, archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, kind: true, last4: true, isDefault: true },
  });
  return rows.map((row) => ({ ...row, kind: row.kind as AccountKind }));
}

/**
 * Balances for every open account.
 *
 * One grouped query rather than one per account: the number of accounts is
 * small but the number of transactions is not, and this is on the dashboard's
 * critical path.
 */
export async function listAccountBalances(scope: LedgerScope): Promise<{
  accounts: AccountBalance[];
  /** Rows from before accounts existed. Real money, no known home. */
  unassignedMinor: number;
  unassignedCount: number;
  totalMinor: number;
}> {
  await ensureAccounts(scope.userId, scope.currency);

  const [accounts, sums] = await Promise.all([
    prisma.account.findMany({
      where: { userId: scope.userId, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.transaction.groupBy({
      by: ['accountId', 'kind'],
      where: { userId: scope.userId },
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
  ]);

  // accountId → signed movement. Income adds, expense subtracts; transfers are
  // deliberately NOT filtered out here, because they are what moves a balance.
  const movement = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const row of sums) {
    const key = row.accountId ?? '';
    const signed = (row.kind === 'income' ? 1 : -1) * (row._sum.amountMinor ?? 0);
    movement.set(key, (movement.get(key) ?? 0) + signed);
    counts.set(key, (counts.get(key) ?? 0) + row._count._all);
  }

  const balances: AccountBalance[] = accounts.map((account) => {
    const balanceMinor = account.openingBalanceMinor + (movement.get(account.id) ?? 0);
    return {
      id: account.id,
      name: account.name,
      kind: account.kind as AccountKind,
      last4: account.last4,
      isDefault: account.isDefault,
      openingBalanceMinor: account.openingBalanceMinor,
      balanceMinor,
      formattedBalance: formatMoney(balanceMinor, scope.currency),
      entryCount: counts.get(account.id) ?? 0,
    };
  });

  const unassignedMinor = movement.get('') ?? 0;

  return {
    accounts: balances,
    unassignedMinor,
    unassignedCount: counts.get('') ?? 0,
    totalMinor: balances.reduce((sum, a) => sum + a.balanceMinor, 0) + unassignedMinor,
  };
}

export async function createAccount(
  userId: string,
  input: {
    name: string;
    kind: AccountKind;
    last4?: string | null;
    openingBalanceMinor?: number;
    currency: string;
  },
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const name = input.name.trim().slice(0, 40);
  if (!name) return { ok: false, error: 'Give the account a name.' };

  // Seed first, so "everyone has a Cash account" holds however they arrive.
  // Without this, someone whose first action is adding a bank account never
  // gets one — and then an ATM withdrawal has nowhere to move money to and
  // quietly goes back to being counted as spending.
  await ensureAccounts(userId, input.currency);

  // Case-insensitive: someone retyping "cash" to get back the "Cash" they
  // closed means that account, not a second one beside it.
  const clash = await prisma.account.findFirst({
    where: { userId, name: { equals: name, mode: 'insensitive' } },
  });
  if (clash) {
    if (clash.archivedAt) {
      await prisma.account.update({ where: { id: clash.id }, data: { archivedAt: null } });
      return { ok: true, id: clash.id };
    }
    return { ok: false, error: `You already have an account called ${clash.name}.` };
  }

  // Two accounts cannot share the digits a bank masks, or an imported message
  // matches both and gets routed to neither.
  const last4 = normaliseLast4(input.last4);
  if (last4) {
    const sameTail = await prisma.account.findFirst({
      where: { userId, archivedAt: null, last4 },
      select: { name: true },
    });
    if (sameTail) {
      return {
        ok: false,
        error: `${sameTail.name} already ends in ${last4}. Leave this blank, or a bank message can't tell the two apart.`,
      };
    }
  }

  const count = await prisma.account.count({ where: { userId } });
  const created = await prisma.account.create({
    data: {
      userId,
      name,
      kind: input.kind,
      last4,
      currency: input.currency,
      openingBalanceMinor: input.openingBalanceMinor ?? 0,
      isDefault: count === 0,
      sortOrder: count,
    },
  });

  return { ok: true, id: created.id };
}

export async function updateAccount(
  userId: string,
  id: string,
  patch: { name?: string; last4?: string | null; openingBalanceMinor?: number },
): Promise<boolean> {
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 40);
    if (!name) return false;
    data.name = name;
  }
  if (patch.last4 !== undefined) data.last4 = normaliseLast4(patch.last4);
  if (patch.openingBalanceMinor !== undefined) data.openingBalanceMinor = patch.openingBalanceMinor;
  if (Object.keys(data).length === 0) return false;

  const { count } = await prisma.account.updateMany({ where: { id, userId }, data });
  return count > 0;
}

/**
 * Close an account without losing its history.
 *
 * Archive rather than delete, always. The transactions on it are real things
 * that happened; a closed card does not un-buy the groceries.
 */
export async function archiveAccount(userId: string, id: string): Promise<boolean> {
  const account = await prisma.account.findFirst({ where: { id, userId, archivedAt: null } });
  if (!account) return false;

  await prisma.account.update({ where: { id }, data: { archivedAt: new Date(), isDefault: false } });

  if (account.isDefault) {
    const next = await prisma.account.findFirst({
      where: { userId, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    if (next) await prisma.account.update({ where: { id: next.id }, data: { isDefault: true } });
  }

  return true;
}

/**
 * Accounts they have closed.
 *
 * These must stay visible somewhere. Closing is one click and the history it
 * holds is real money; a closed account with no way back is a trapdoor, not a
 * feature.
 */
export async function listArchivedAccounts(userId: string): Promise<AccountOption[]> {
  const rows = await prisma.account.findMany({
    where: { userId, archivedAt: { not: null } },
    orderBy: { archivedAt: 'desc' },
    select: { id: true, name: true, kind: true, last4: true, isDefault: true },
  });
  return rows.map((row) => ({ ...row, kind: row.kind as AccountKind }));
}

export async function reopenAccount(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.account.updateMany({
    where: { id, userId, archivedAt: { not: null } },
    data: { archivedAt: null },
  });
  return count > 0;
}

export async function setDefaultAccount(userId: string, id: string): Promise<boolean> {
  const owned = await prisma.account.findFirst({ where: { id, userId, archivedAt: null } });
  if (!owned) return false;

  await prisma.$transaction([
    prisma.account.updateMany({ where: { userId }, data: { isDefault: false } }),
    prisma.account.update({ where: { id }, data: { isDefault: true } }),
  ]);
  return true;
}

export async function defaultAccountId(userId: string, currency: string): Promise<string | null> {
  await ensureAccounts(userId, currency);
  const row = await prisma.account.findFirst({
    where: { userId, archivedAt: null, isDefault: true },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** Resolve whatever a caller said — an id, or a name — to an account id. */
export async function resolveAccount(
  userId: string,
  input: string | null | undefined,
): Promise<string | null> {
  const wanted = input?.trim();
  if (!wanted) return null;

  const row = await prisma.account.findFirst({
    where: {
      userId,
      archivedAt: null,
      OR: [{ id: wanted }, { name: { equals: wanted, mode: 'insensitive' } }],
    },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Which account a bank message came from, by the digits it masks.
 *
 * Only answers when exactly one account matches. Two cards ending 7890 is
 * unlikely but possible, and guessing between them would silently file money
 * against the wrong balance.
 */
export async function matchAccountByLast4(
  userId: string,
  last4: string | null,
): Promise<string | null> {
  const digits = normaliseLast4(last4);
  if (!digits) return null;

  const rows = await prisma.account.findMany({
    where: { userId, archivedAt: null, last4: digits },
    select: { id: true },
    take: 2,
  });
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * The first open account of a given kind — how an ATM finds "cash".
 *
 * A lookup, so it does not seed. Every write path seeds before calling it.
 */
export async function findAccountByKind(
  userId: string,
  kind: AccountKind,
): Promise<string | null> {
  const row = await prisma.account.findFirst({
    where: { userId, archivedAt: null, kind },
    orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
    select: { id: true },
  });
  return row?.id ?? null;
}

// ── Transfers ───────────────────────────────────────────────────────────────

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amountMinor: number;
  occurredAt: Date;
  note?: string | null;
  source?: string;
  /** Idempotency for imported transfers; becomes the importKey of the out leg. */
  importKey?: string | null;
}

/**
 * Move money between two accounts.
 *
 * Written as one database transaction because half a transfer is worse than no
 * transfer: a balance that lost money it never gained is a bug the user finds
 * before we do.
 */
export async function recordTransfer(
  scope: Pick<LedgerScope, 'userId' | 'currency'>,
  input: TransferInput,
): Promise<{ ok: boolean; error?: string; duplicate?: boolean }> {
  if (input.fromAccountId === input.toAccountId) {
    return { ok: false, error: 'Pick two different accounts.' };
  }
  if (input.amountMinor <= 0) {
    return { ok: false, error: 'Amount must be greater than zero.' };
  }

  // An imported transfer can arrive twice — the same bank message pasted in an
  // overlapping range. Answer "already have it" rather than throwing: a
  // duplicate is an ordinary outcome of how people use the import screen, not
  // an error, and an exception here would surface as a 500 on a Server Action.
  if (input.importKey) {
    const existing = await prisma.transaction.findFirst({
      where: { userId: scope.userId, importKey: input.importKey },
      select: { id: true },
    });
    if (existing) return { ok: false, duplicate: true };
  }

  const owned = await prisma.account.findMany({
    where: {
      userId: scope.userId,
      archivedAt: null,
      id: { in: [input.fromAccountId, input.toAccountId] },
    },
    select: { id: true, name: true },
  });
  if (owned.length !== 2) return { ok: false, error: 'One of those accounts no longer exists.' };

  const nameOf = (id: string) => owned.find((a) => a.id === id)?.name ?? 'account';
  const groupId = `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  const common = {
    userId: scope.userId,
    currency: scope.currency,
    amountMinor: input.amountMinor,
    category: TRANSFER_CATEGORY,
    occurredAt: input.occurredAt,
    source: input.source ?? 'manual',
    transferGroupId: groupId,
    note: input.note?.slice(0, 200) ?? null,
  };

  try {
    // One statement, so a crash cannot leave a balance that lost money it never
    // gained. Half a transfer is worse than no transfer.
    await prisma.transaction.createMany({
      data: [
        {
          ...common,
          kind: 'expense' as const,
          accountId: input.fromAccountId,
          merchant: `→ ${nameOf(input.toAccountId)}`,
          importKey: input.importKey ?? null,
        },
        {
          ...common,
          kind: 'income' as const,
          accountId: input.toAccountId,
          merchant: `← ${nameOf(input.fromAccountId)}`,
          // Only one leg carries the import key: the unique index is per-row, and
          // both legs sharing a key would collide with each other.
          importKey: null,
        },
      ],
    });
  } catch (err) {
    // Closes the gap between the check above and this write.
    if ((err as { code?: string }).code === 'P2002') return { ok: false, duplicate: true };
    throw err;
  }

  return { ok: true };
}

function normaliseLast4(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}
