// Better Auth, configured for this app.
//
// Two decisions are worth reading:
//
// **No passwords.** Google, or a six-digit code sent to an email address. A
// password that cannot be set is a password that cannot be reused from a leaked
// site, and for a finance app that is the whole threat model. It also deletes
// the reset flow, the "forgot password" flow and the strength meter.
//
// A **code** rather than a link, deliberately. A magic link opens in whatever
// browser the mail app hands it to — usually an in-app webview — so the session
// lands somewhere other than the tab the person was using, and the app they
// started in is still signed out. A code keeps the whole flow in one tab, works
// the same on a phone, survives corporate link scanners that eat one-time URLs,
// and is the pattern every bank here has already taught people. It is also the
// only one of the two that is not awkward in a native app.
//
// **Anonymous first.** Someone can open the app, log a week of spending and
// only then decide whether to keep it. When they sign in, `onLinkAccount` moves
// the whole ledger onto the real account. Without that hook, signing up would
// silently hand them an empty app and leave their data attached to a cookie.

import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { nextCookies } from 'better-auth/next-js';
import { anonymous, emailOTP } from 'better-auth/plugins';

import { prisma } from '../db';
import { mergeLedger } from './merge';
import { sendSignInCode } from './email';

function secret(): string {
  // Falls back to the pre-auth cookie secret so an existing .env keeps working.
  const value = process.env.BETTER_AUTH_SECRET || process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    throw new Error('BETTER_AUTH_SECRET must be set to a random string of 16+ chars');
  }
  return value;
}

export function baseUrl(): string {
  return (
    process.env.BETTER_AUTH_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    'http://localhost:3000'
  );
}

const googleId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

/** Advertised to the sign-in page so it only offers what is actually wired up. */
export const GOOGLE_ENABLED = Boolean(googleId && googleSecret);

export const auth = betterAuth({
  secret: secret(),
  baseURL: baseUrl(),

  database: prismaAdapter(prisma, { provider: 'postgresql' }),

  // `Account` in this codebase is a wallet — cash, a card, a bank account —
  // and has been since long before there was a login. Better Auth's models are
  // renamed rather than the domain's.
  session: { modelName: 'AuthSession' },
  account: { modelName: 'AuthAccount' },
  verification: { modelName: 'AuthVerification' },

  emailAndPassword: { enabled: false },

  databaseHooks: {
    user: {
      create: {
        // Better Auth writes only the fields it owns, so without this every
        // new account falls back to the Prisma column defaults — USD and UTC —
        // regardless of where the deployment actually is. A Sri Lankan user
        // signing in and finding their ledger in dollars is the visible symptom.
        before: async (user) => ({
          data: {
            ...user,
            currency: process.env.DEFAULT_CURRENCY?.trim().toUpperCase() || 'USD',
            timezone: process.env.DEFAULT_TIMEZONE?.trim() || 'UTC',
          },
        }),
      },
    },
  },

  socialProviders: GOOGLE_ENABLED
    ? { google: { clientId: googleId!, clientSecret: googleSecret! } }
    : {},

  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 60 * 10,
      allowedAttempts: 3,
      // Hashed at rest: a leaked database dump is then a list of hashes, not a
      // list of live sign-in codes for every account waiting on one.
      storeOTP: 'hashed',
      sendVerificationOTP: async ({ email, otp, type }) => {
        await sendSignInCode(email, otp, type);
      },
    }),

    anonymous({
      emailDomainName: 'anonymous.local',
      generateName: () => 'Guest',

      // The whole reason anonymous accounts are safe to offer.
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        const report = await mergeLedger(anonymousUser.user.id, newUser.user.id);
        console.info(
          '[auth] merged anonymous ledger',
          anonymousUser.user.id,
          '→',
          newUser.user.id,
          report,
        );
      },
    }),

    // Must be last: it wraps every other plugin's endpoints so that calling
    // them from a Server Action or route handler sets the session cookie.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
