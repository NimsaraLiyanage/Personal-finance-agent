// Demo session: an anonymous user identified by an HMAC-signed cookie.
//
// This is the ONLY module that knows how a request maps to a user id. Every
// agent tool receives an already-resolved `userId`, so swapping this for
// Clerk / Auth.js / NextAuth is a one-file change — the agent layer never
// learns what authentication is.
//
// The signature matters even for a demo: without it the cookie is a raw user
// id and anyone can read anyone else's ledger by editing it in devtools.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { prisma } from './db';

const COOKIE_NAME = 'pfa_uid';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    throw new Error('SESSION_SECRET must be set to a random string of 16+ chars');
  }
  return value;
}

function sign(userId: string): string {
  return createHmac('sha256', secret()).update(userId).digest('base64url');
}

function verify(value: string): string | null {
  const idx = value.lastIndexOf('.');
  if (idx <= 0) return null;
  const userId = value.slice(0, idx);
  const provided = value.slice(idx + 1);
  const expected = sign(userId);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — check first.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return userId;
}

/**
 * Resolve the current user, creating one on first visit.
 *
 * Returns the id plus the cookie value the caller must set when a new user was
 * minted. Route handlers set it on their own response; Server Components can
 * only read cookies, so they get `setCookie: null` and rely on the route that
 * ran first.
 */
export async function resolveUser(): Promise<{
  userId: string;
  currency: string;
  timezone: string;
  setCookie: string | null;
}> {
  const jar = await cookies();
  const raw = jar.get(COOKIE_NAME)?.value;

  if (raw) {
    const userId = verify(raw);
    if (userId) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user) {
        return { userId: user.id, currency: user.currency, timezone: user.timezone, setCookie: null };
      }
    }
  }

  const user = await prisma.user.create({
    data: {
      currency: process.env.DEFAULT_CURRENCY?.trim().toUpperCase() || 'USD',
      timezone: process.env.DEFAULT_TIMEZONE?.trim() || 'UTC',
    },
  });
  return {
    userId: user.id,
    currency: user.currency,
    timezone: user.timezone,
    setCookie: `${user.id}.${sign(user.id)}`,
  };
}

/**
 * Read the current user without ever creating one.
 *
 * Server Components can read cookies but not set them, so `resolveUser` is
 * unusable during render: a first-time visitor would mint a fresh user row on
 * every paint, none of which they could ever be issued a cookie for. Pages call
 * this instead and render their empty state when it returns null — the row gets
 * created by the first write (a Server Action) or the first chat turn, both of
 * which can set the cookie on their response.
 */
export async function readUser(): Promise<{
  userId: string;
  currency: string;
  timezone: string;
} | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  const userId = verify(raw);
  if (!userId) return null;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  return { userId: user.id, currency: user.currency, timezone: user.timezone };
}

export const SESSION_COOKIE = {
  name: COOKIE_NAME,
  options: {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  },
};
