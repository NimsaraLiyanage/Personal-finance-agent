// User-owned categories, and the corrections the agent has learned.
//
// Everything that turns a phrase into a category slug goes through
// `resolveCategory`. There is exactly one such path on purpose: the model, the
// manual form, a CSV import and a future SMS parser must all land on the same
// slug for the same words, or the ledger quietly grows "dining", "Dining" and
// "food" as three separate things.

import { prisma } from '../db';
import { CATEGORIES } from '../agent/types';

export interface CategoryOption {
  slug: string;
  label: string;
  builtIn: boolean;
}

/** The starting set. Seeded per user, then theirs to change. */
const DEFAULTS: Array<{ slug: string; label: string }> = CATEGORIES.map((slug) => ({
  slug,
  label: slug.charAt(0).toUpperCase() + slug.slice(1),
}));

/** For the signed-out onboarding form, which has no user to read from yet. */
export const DEFAULT_CATEGORY_OPTIONS: CategoryOption[] = DEFAULTS.map((c) => ({
  ...c,
  builtIn: true,
}));

/** Lowercase, spaces to dashes, nothing exotic. Stable once written. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9඀-෿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Make sure this user has categories, seeding the defaults on first contact.
 *
 * Idempotent and safe to call on every read — `createMany` with `skipDuplicates`
 * means two concurrent requests can't double-seed.
 */
export async function ensureCategories(userId: string): Promise<void> {
  const existing = await prisma.category.count({ where: { userId } });
  if (existing > 0) return;

  await prisma.category.createMany({
    data: DEFAULTS.map((c, i) => ({
      userId,
      slug: c.slug,
      label: c.label,
      builtIn: true,
      sortOrder: i,
    })),
    skipDuplicates: true,
  });
}

export async function listCategories(userId: string): Promise<CategoryOption[]> {
  await ensureCategories(userId);
  const rows = await prisma.category.findMany({
    where: { userId, archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    select: { slug: true, label: true, builtIn: true },
  });
  return rows;
}

/**
 * Turn whatever the caller said into a slug that exists.
 *
 * Order matters. A learned correction beats an exact name match, because a
 * correction is the user explicitly overruling the obvious reading.
 */
export async function resolveCategory(
  userId: string,
  input: string,
  options: { merchant?: string | null; create?: boolean } = {},
): Promise<string> {
  await ensureCategories(userId);

  // 1. A remembered correction for this merchant wins outright.
  if (options.merchant) {
    const learned = await matchCategoryRule(userId, options.merchant);
    if (learned) return learned;
  }

  const wanted = slugify(input);
  const categories = await prisma.category.findMany({
    where: { userId },
    select: { slug: true, label: true, archivedAt: true },
  });

  // 2. Exact slug, then case-insensitive label.
  const bySlug = categories.find((c) => c.slug === wanted);
  if (bySlug) return bySlug.slug;

  const byLabel = categories.find((c) => slugify(c.label) === wanted);
  if (byLabel) return byLabel.slug;

  // 3. A rule keyed on the phrase itself ("bus eka" → transport).
  const phraseRule = await matchCategoryRule(userId, input);
  if (phraseRule) return phraseRule;

  // 4. Nothing matched. Make it, unless the caller only wanted a lookup.
  if (options.create === false || !wanted) return 'other';

  const created = await prisma.category.upsert({
    where: { userId_slug: { userId, slug: wanted } },
    create: {
      userId,
      slug: wanted,
      label: input.trim().slice(0, 40) || wanted,
      builtIn: false,
      sortOrder: 100,
    },
    update: { archivedAt: null },
  });
  return created.slug;
}

export async function createCategory(userId: string, label: string): Promise<CategoryOption | null> {
  const slug = slugify(label);
  if (!slug) return null;

  const row = await prisma.category.upsert({
    where: { userId_slug: { userId, slug } },
    create: { userId, slug, label: label.trim().slice(0, 40), builtIn: false, sortOrder: 100 },
    // Un-archive rather than complain: "add groceries" when groceries is
    // retired obviously means bring it back.
    update: { archivedAt: null, label: label.trim().slice(0, 40) },
  });
  return { slug: row.slug, label: row.label, builtIn: row.builtIn };
}

/** Retire a category. History keeps its slug; the picker stops offering it. */
export async function archiveCategory(userId: string, slug: string): Promise<boolean> {
  const { count } = await prisma.category.updateMany({
    where: { userId, slug, archivedAt: null },
    data: { archivedAt: new Date() },
  });
  return count > 0;
}

// ── Learned corrections ─────────────────────────────────────────────────────

/**
 * Find a rule matching this text.
 *
 * Longest pattern first, so a specific rule ("uber eats" → dining) beats a
 * general one ("uber" → transport) instead of losing a coin flip.
 */
export async function matchCategoryRule(
  userId: string,
  text: string,
): Promise<string | null> {
  const haystack = text.trim().toLowerCase();
  if (!haystack) return null;

  const rules = await prisma.categoryRule.findMany({
    where: { userId },
    select: { id: true, pattern: true, categorySlug: true },
  });

  const hit = rules
    .filter((r) => haystack.includes(r.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length)[0];
  if (!hit) return null;

  // Fire-and-forget: a usage counter is not worth delaying the write for.
  void prisma.categoryRule
    .update({ where: { id: hit.id }, data: { hits: { increment: 1 } } })
    .catch(() => {});

  return hit.categorySlug;
}

export async function rememberCategoryRule(
  userId: string,
  pattern: string,
  categorySlug: string,
  source: 'correction' | 'manual' = 'correction',
): Promise<boolean> {
  const key = pattern.trim().toLowerCase();
  // One-character patterns would match nearly everything.
  if (key.length < 2) return false;

  await prisma.categoryRule.upsert({
    where: { userId_pattern: { userId, pattern: key } },
    create: { userId, pattern: key, categorySlug, source },
    update: { categorySlug, source },
  });
  return true;
}

export async function listCategoryRules(userId: string) {
  return prisma.categoryRule.findMany({
    where: { userId },
    orderBy: [{ hits: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, pattern: true, categorySlug: true, hits: true, source: true },
  });
}

export async function forgetCategoryRule(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.categoryRule.deleteMany({ where: { id, userId } });
  return count > 0;
}
