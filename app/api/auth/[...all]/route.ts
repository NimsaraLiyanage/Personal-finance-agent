// Better Auth's own endpoints: sign-in, callbacks, session, sign-out.
//
// One catch-all rather than a route per flow — the library owns the paths, and
// hand-writing them is how they drift out of sync with the client SDK.

import { toNextJsHandler } from 'better-auth/next-js';

import { auth } from '@/lib/auth';

export const runtime = 'nodejs';

export const { GET, POST } = toNextJsHandler(auth.handler);
