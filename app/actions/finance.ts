'use server';

// Dashboard writes.
//
// Server Actions rather than route handlers: these are form submissions from
// the user's own screen, not an API anyone else consumes, and an action can set
// the session cookie (which a Server Component cannot) — so the first manual
// entry is also what bootstraps an anonymous visitor into a real user row.
//
// Every action re-resolves the session server-side. The client never sends a
// user id, so a tampered form body can only ever write to the caller's own
// ledger.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import {
  archiveAccount,
  createAccount,
  defaultAccountId,
  recordTransfer,
  reopenAccount,
  resolveAccount,
  setDefaultAccount,
} from '@/lib/finance/accounts';
import { acknowledgeReminder, deleteReminder } from '@/lib/finance/reminders';
import { toMinor } from '@/lib/money';
import { resolveUser } from '@/lib/session';
import { resolveCategory } from '@/lib/finance/categories';
import { formatDateInZone, parseOccurredAt } from '@/lib/agent/time';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Better Auth issues its own cookie via the `nextCookies` plugin. */
async function session() {
  return resolveUser();
}

function refresh() {
  revalidatePath('/');
  revalidatePath('/chat');
  // The statement reads the same rows. Leaving it stale is how a figure someone
  // just corrected on the dashboard goes on being wrong one tab away.
  revalidatePath('/summary');
}

// ── Transactions ────────────────────────────────────────────────────────────

const TransactionSchema = z.object({
  kind: z.enum(['expense', 'income']),
  // Comes off an <input type="number">, so it arrives as a string.
  amount: z.coerce.number().positive('Amount must be greater than zero.'),
  // Free text: the manual form and the agent must be able to create the same
  // user-owned category, so both go through resolveCategory below.
  category: z.string().trim().min(1).max(40),
  merchant: z.string().trim().max(80).optional(),
  note: z.string().trim().max(200).optional(),
  accountId: z.string().trim().optional(),
  occurredOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')
    .optional(),
});

export async function addTransaction(formData: FormData): Promise<ActionResult> {
  const parsed = TransactionSchema.safeParse({
    kind: formData.get('kind'),
    amount: formData.get('amount'),
    category: formData.get('category'),
    merchant: formData.get('merchant') || undefined,
    note: formData.get('note') || undefined,
    accountId: formData.get('accountId') || undefined,
    occurredOn: formData.get('occurredOn') || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const { userId, currency, timezone } = await session();
  const amountMinor = toMinor(parsed.data.amount, currency);
  if (amountMinor <= 0) return { ok: false, error: 'Amount must be greater than zero.' };

  const category = await resolveCategory(userId, parsed.data.category, {
    merchant: parsed.data.merchant,
  });

  // `resolveAccount` returns null for an id that isn't theirs, so a tampered
  // form body falls back to their default rather than writing to a stranger's.
  const accountId =
    (await resolveAccount(userId, parsed.data.accountId)) ??
    (await defaultAccountId(userId, currency));

  await prisma.transaction.create({
    data: {
      userId,
      kind: parsed.data.kind,
      amountMinor,
      currency,
      merchant: parsed.data.merchant || null,
      category,
      note: parsed.data.note || null,
      occurredAt: parseOccurredAt(parsed.data.occurredOn, new Date(), timezone),
      source: 'manual',
      accountId,
    },
  });

  refresh();
  return { ok: true };
}

const EditTransactionSchema = TransactionSchema.extend({
  id: z.string().trim().min(1),
});

/**
 * Fix an entry that was logged wrong.
 *
 * The alternative — delete and re-add — loses the row's `createdAt`, its
 * `source`, and its `importKey`, which is the thing that stops a re-imported
 * statement double-counting it. An edit keeps all three, so correcting a typo
 * cannot quietly re-open the door to a duplicate.
 */
export async function updateTransaction(formData: FormData): Promise<ActionResult> {
  const parsed = EditTransactionSchema.safeParse({
    id: formData.get('id'),
    kind: formData.get('kind'),
    amount: formData.get('amount'),
    category: formData.get('category'),
    merchant: formData.get('merchant') || undefined,
    note: formData.get('note') || undefined,
    accountId: formData.get('accountId') || undefined,
    occurredOn: formData.get('occurredOn') || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const { userId, currency, timezone } = await session();

  // Scoped read: an id from another ledger comes back null, so the worst a
  // tampered form body can do is edit nothing.
  const existing = await prisma.transaction.findFirst({
    where: { id: parsed.data.id, userId },
    select: { id: true, occurredAt: true, accountId: true, transferGroupId: true },
  });
  if (!existing) return { ok: false, error: 'That transaction no longer exists.' };

  // A transfer is two rows that have to agree with each other — same amount,
  // same day, opposite directions. Editing one leg through this form would
  // leave the other saying something else, and both balances would be wrong.
  if (existing.transferGroupId) {
    return {
      ok: false,
      error: 'A transfer is a pair of entries. Remove it and record it again to change it.',
    };
  }

  const amountMinor = toMinor(parsed.data.amount, currency);
  if (amountMinor <= 0) return { ok: false, error: 'Amount must be greater than zero.' };

  // No merchant hint here, unlike `addTransaction`: a learned rule exists to
  // beat a *guess*, and this is the user pointing at one row and naming it.
  // Letting "uber → transport" override them on an explicit edit is the app
  // arguing with a correction it was given.
  const category = await resolveCategory(userId, parsed.data.category);

  // Only re-derive the instant when the day actually changed. `parseOccurredAt`
  // lands a bare date at noon, so re-parsing an untouched date would silently
  // move the time of every entry someone edits.
  const currentOn = formatDateInZone(existing.occurredAt, timezone);
  const occurredAt =
    parsed.data.occurredOn && parsed.data.occurredOn !== currentOn
      ? parseOccurredAt(parsed.data.occurredOn, existing.occurredAt, timezone)
      : existing.occurredAt;

  // Keeps the row where it is when the form had no account field to show
  // (one account) or named one that isn't theirs — never orphans it.
  const accountId = parsed.data.accountId
    ? ((await resolveAccount(userId, parsed.data.accountId)) ?? existing.accountId)
    : existing.accountId;

  await prisma.transaction.updateMany({
    where: { id: existing.id, userId },
    data: {
      kind: parsed.data.kind,
      amountMinor,
      merchant: parsed.data.merchant || null,
      category,
      note: parsed.data.note || null,
      occurredAt,
      accountId,
    },
  });

  refresh();
  return { ok: true };
}

// ── Accounts ────────────────────────────────────────────────────────────────

const AccountSchema = z.object({
  name: z.string().trim().min(1, 'Give the account a name.').max(40),
  kind: z.enum(['cash', 'bank', 'card', 'wallet']),
  last4: z.string().trim().max(24).optional(),
  openingBalance: z.coerce.number().optional(),
});

export async function addAccount(formData: FormData): Promise<ActionResult> {
  const parsed = AccountSchema.safeParse({
    name: formData.get('name'),
    kind: formData.get('kind'),
    last4: formData.get('last4') || undefined,
    openingBalance: formData.get('openingBalance') || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const { userId, currency } = await session();
  const result = await createAccount(userId, {
    name: parsed.data.name,
    kind: parsed.data.kind,
    last4: parsed.data.last4 ?? null,
    // Opening balances can legitimately be negative — that is what a credit
    // card with something on it looks like.
    openingBalanceMinor: parsed.data.openingBalance
      ? toMinor(parsed.data.openingBalance, currency)
      : 0,
    currency,
  });

  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true };
}

export async function closeAccount(id: string): Promise<ActionResult> {
  const { userId } = await session();
  const ok = await archiveAccount(userId, id);
  if (!ok) return { ok: false, error: 'That account is already closed.' };
  refresh();
  return { ok: true };
}

export async function reopenClosedAccount(id: string): Promise<ActionResult> {
  const { userId } = await session();
  const ok = await reopenAccount(userId, id);
  if (!ok) return { ok: false, error: 'That account is already open.' };
  refresh();
  return { ok: true };
}

export async function makeAccountDefault(id: string): Promise<ActionResult> {
  const { userId } = await session();
  const ok = await setDefaultAccount(userId, id);
  if (!ok) return { ok: false, error: 'That account no longer exists.' };
  refresh();
  return { ok: true };
}

const TransferSchema = z.object({
  fromAccountId: z.string().trim().min(1, 'Pick where the money left.'),
  toAccountId: z.string().trim().min(1, 'Pick where the money went.'),
  amount: z.coerce.number().positive('Amount must be greater than zero.'),
  occurredOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')
    .optional(),
  note: z.string().trim().max(200).optional(),
});

export async function transferBetweenAccounts(formData: FormData): Promise<ActionResult> {
  const parsed = TransferSchema.safeParse({
    fromAccountId: formData.get('fromAccountId'),
    toAccountId: formData.get('toAccountId'),
    amount: formData.get('amount'),
    occurredOn: formData.get('occurredOn') || undefined,
    note: formData.get('note') || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const { userId, currency, timezone } = await session();
  const result = await recordTransfer(
    { userId, currency },
    {
      fromAccountId: parsed.data.fromAccountId,
      toAccountId: parsed.data.toAccountId,
      amountMinor: toMinor(parsed.data.amount, currency),
      occurredAt: parseOccurredAt(parsed.data.occurredOn, new Date(), timezone),
      note: parsed.data.note ?? null,
    },
  );

  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true };
}

export async function removeTransaction(id: string): Promise<ActionResult> {
  const { userId } = await session();

  // Scoped delete: `deleteMany` with the user id in the filter means a guessed
  // id from another ledger matches nothing instead of deleting someone's row.
  const { count } = await prisma.transaction.deleteMany({ where: { id, userId } });
  if (count === 0) return { ok: false, error: 'That transaction no longer exists.' };

  refresh();
  return { ok: true };
}

// ── Budgets ─────────────────────────────────────────────────────────────────

const BudgetSchema = z.object({
  category: z.string().trim().min(1).max(40),
  monthlyLimit: z.coerce.number().positive('A budget must be greater than zero.'),
});

export async function saveBudget(formData: FormData): Promise<ActionResult> {
  const parsed = BudgetSchema.safeParse({
    category: formData.get('category'),
    monthlyLimit: formData.get('monthlyLimit'),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const { userId, currency } = await session();
  const limitMinor = toMinor(parsed.data.monthlyLimit, currency);
  if (limitMinor <= 0) return { ok: false, error: 'A budget must be greater than zero.' };

  const category = await resolveCategory(userId, parsed.data.category);
  await prisma.budget.upsert({
    where: { userId_category: { userId, category } },
    create: { userId, category, limitMinor, currency },
    update: { limitMinor, currency },
  });

  refresh();
  return { ok: true };
}

export async function removeBudget(category: string): Promise<ActionResult> {
  const { userId } = await session();
  await prisma.budget.deleteMany({ where: { userId, category } });
  refresh();
  return { ok: true };
}

// ── Reminders ───────────────────────────────────────────────────────────────

/** Acknowledge a due reminder: it has been delivered and acted on. */
export async function dismissReminder(id: string): Promise<ActionResult> {
  const { userId } = await session();
  const ok = await acknowledgeReminder(userId, id);
  if (!ok) return { ok: false, error: 'That reminder is no longer waiting.' };
  refresh();
  return { ok: true };
}

/** Drop a reminder the person no longer wants at all. */
export async function removeReminder(id: string): Promise<ActionResult> {
  const { userId } = await session();
  await deleteReminder(userId, id);
  refresh();
  return { ok: true };
}
