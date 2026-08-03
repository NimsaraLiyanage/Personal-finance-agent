'use client';

// The browser half. Safe to import from Client Components: it holds no secret
// and talks only to /api/auth on this origin.

import { createAuthClient } from 'better-auth/react';
import { anonymousClient, emailOTPClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [emailOTPClient(), anonymousClient()],
});

export const { signIn, signOut, useSession } = authClient;
