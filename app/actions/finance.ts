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
import { cookies } from 'next/headers';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { toMinor } from '@/lib/money';
import { resolveUser, SESSION_COOKIE } from '@/lib/session';
import { CATEGORIES } from '@/lib/agent/types';
import { parseOccurredAt } from '@/lib/agent/time';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Resolve the user and, when one was just minted, issue its cookie. */
async function session() {
  const resolved = await resolveUser();
  if (resolved.setCookie) {
    const jar = await cookies();
    jar.set(SESSION_COOKIE.name, resolved.setCookie, SESSION_COOKIE.options);
  }
  return resolved;
}

function refresh() {
  revalidatePath('/');
  revalidatePath('/chat');
}

// ── Transactions ────────────────────────────────────────────────────────────

const TransactionSchema = z.object({
  kind: z.enum(['expense', 'income']),
  // Comes off an <input type="number">, so it arrives as a string.
  amount: z.coerce.number().positive('Amount must be greater than zero.'),
  category: z.enum(CATEGORIES),
  merchant: z.string().trim().max(80).optional(),
  note: z.string().trim().max(200).optional(),
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
    occurredOn: formData.get('occurredOn') || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const { userId, currency, timezone } = await session();
  const amountMinor = toMinor(parsed.data.amount, currency);
  if (amountMinor <= 0) return { ok: false, error: 'Amount must be greater than zero.' };

  await prisma.transaction.create({
    data: {
      userId,
      kind: parsed.data.kind,
      amountMinor,
      currency,
      merchant: parsed.data.merchant || null,
      category: parsed.data.category,
      note: parsed.data.note || null,
      occurredAt: parseOccurredAt(parsed.data.occurredOn, new Date(), timezone),
      source: 'manual',
    },
  });

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
  category: z.enum(CATEGORIES),
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

  await prisma.budget.upsert({
    where: { userId_category: { userId, category: parsed.data.category } },
    create: { userId, category: parsed.data.category, limitMinor, currency },
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
