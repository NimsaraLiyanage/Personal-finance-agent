// How a request becomes a user id.
//
// This is still the ONLY module that knows. That was the point of the original
// shape and it survived the change: swapping a signed cookie for Better Auth
// touched this file, and every tool, action and route above it kept working
// unchanged. The agent layer has never learned what authentication is.
//
// Three cases, in order:
//
//   1. A Better Auth session — signed in with Google or a magic link, or an
//      anonymous account created on a previous visit.
//   2. A legacy `pfa_uid` cookie from before there was a login. Bridged once:
//      a Better Auth anonymous account is minted, the old ledger is moved onto
//      it, and the old cookie is retired. Nobody loses a month of entries
//      because we changed auth libraries.
//   3. Nothing. `readUser` returns null (a Server Component cannot mint one);
//      `resolveUser` creates an anonymous account, because it is only ever
//      called by something that is about to write.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';

import { auth } from './auth';
import { mergeLedger } from './auth/merge';
import { prisma } from './db';

const LEGACY_COOKIE = 'pfa_uid';

export interface SessionUser {
  userId: string;
  currency: string;
  timezone: string;
}

// ── The legacy cookie ───────────────────────────────────────────────────────

function legacySecret(): string | null {
  const value = process.env.SESSION_SECRET;
  return value && value.length >= 16 ? value : null;
}

function verifyLegacy(value: string): string | null {
  const secret = legacySecret();
  if (!secret) return null;

  const idx = value.lastIndexOf('.');
  if (idx <= 0) return null;

  const userId = value.slice(0, idx);
  const provided = Buffer.from(value.slice(idx + 1));
  const expected = Buffer.from(createHmac('sha256', secret).update(userId).digest('base64url'));

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  return userId;
}

/** The id behind a still-valid legacy cookie, if that user row still exists. */
async function legacyUserId(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(LEGACY_COOKIE)?.value;
  if (!raw) return null;

  const userId = verifyLegacy(raw);
  if (!userId) return null;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  return user?.id ?? null;
}

function clearLegacyCookie(jar: Awaited<ReturnType<typeof cookies>>) {
  // `delete` rather than expire-in-place: the bridge has already moved the
  // data, and a cookie left behind would try to bridge again next request.
  try {
    jar.delete(LEGACY_COOKIE);
  } catch {
    // Server Components cannot write cookies. The bridge runs from a write
    // path, so this only ever fires on a read and is harmless there.
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

async function currentSessionUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.id ?? null;
}

async function load(userId: string): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, currency: true, timezone: true },
  });
  if (!user) return null;
  return { userId: user.id, currency: user.currency, timezone: user.timezone };
}

/**
 * Read the current user without ever creating one.
 *
 * Server Components can read cookies but not set them, so a function that
 * creates users is unusable during render: a first-time visitor would mint a
 * row on every paint and never be issued a cookie for any of them. Pages call
 * this and render their empty state on null; the row is created by the first
 * write, which is a Server Action or a route handler and can set cookies.
 */
export async function readUser(): Promise<SessionUser | null> {
  const sessionUserId = await currentSessionUserId();
  if (sessionUserId) return load(sessionUserId);

  // A legacy visitor still sees their own ledger while reading. The bridge
  // itself waits for a write.
  const legacy = await legacyUserId();
  return legacy ? load(legacy) : null;
}

/**
 * Resolve the current user, creating an anonymous one if there is none.
 *
 * Only called from paths that are about to write, which is what makes creating
 * a row here reasonable.
 */
export async function resolveUser(): Promise<SessionUser & { setCookie: null }> {
  const requestHeaders = await headers();
  const sessionUserId = await auth.api
    .getSession({ headers: requestHeaders })
    .then((s) => s?.user?.id ?? null);

  if (sessionUserId) {
    const existing = await load(sessionUserId);
    if (existing) return { ...existing, setCookie: null };
  }

  // Mint the anonymous account. Better Auth writes its own cookie through the
  // `nextCookies` plugin, which is why `setCookie` is always null now.
  const created = await auth.api.signInAnonymous({ headers: requestHeaders });
  const newUserId = created?.user?.id;
  if (!newUserId) throw new Error('Could not start a session');

  // The bridge: an older ledger, moved onto the new account exactly once.
  const legacy = await legacyUserId();
  if (legacy && legacy !== newUserId) {
    const report = await mergeLedger(legacy, newUserId);
    await prisma.user.delete({ where: { id: legacy } }).catch(() => {});
    clearLegacyCookie(await cookies());
    console.info('[auth] bridged legacy cookie ledger', legacy, '→', newUserId, report);
  }

  const user = await load(newUserId);
  if (!user) throw new Error('Could not start a session');
  return { ...user, setCookie: null };
}

/**
 * Kept so callers do not have to change.
 *
 * @deprecated Better Auth sets its own cookie; `resolveUser().setCookie` is
 * always null and the branches that read it are dead. Left in place only until
 * the call sites are tidied.
 */
export const SESSION_COOKIE = {
  name: LEGACY_COOKIE,
  options: {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  },
};
