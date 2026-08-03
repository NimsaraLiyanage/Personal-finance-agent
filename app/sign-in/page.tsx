import Link from 'next/link';
import { redirect } from 'next/navigation';

import SignInForm from '@/components/auth/SignInForm';
import { TallyMark } from '@/components/SiteNav';
import { CONTAINER } from '@/components/ui/container';
import { auth, GOOGLE_ENABLED } from '@/lib/auth';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  const session = await auth.api.getSession({ headers: await headers() });

  // Already signed in for real — an anonymous session is not "signed in", and
  // sending those people away is exactly the opposite of what this page is for.
  if (session?.user && !(session.user as { isAnonymous?: boolean }).isAnonymous) {
    redirect('/');
  }

  return (
    <main className="scroll-quiet h-full overflow-y-auto">
      <div className={`${CONTAINER} py-10 sm:py-16`}>
        <div className="mx-auto max-w-sm">
          <div className="mb-6 text-center">
            <TallyMark className="mx-auto size-10" />
            <h1 className="mt-3 text-xl font-semibold tracking-tight">Keep your ledger</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">
              Sign in and it follows you to any device — and stops living in one browser&rsquo;s
              cookie.
            </p>
          </div>

          <SignInForm googleEnabled={GOOGLE_ENABLED} />

          <p className="mt-4 text-center text-xs text-ink-faint">
            <Link href="/" className="text-accent hover:underline">
              Keep looking around first
            </Link>{' '}
            — nothing you log is lost by waiting.
          </p>
        </div>
      </div>
    </main>
  );
}
