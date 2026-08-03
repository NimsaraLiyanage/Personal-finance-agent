'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

import { authClient } from '@/lib/auth/client';

// Sign in: Google, or a six-digit code.
//
// No password field, and none is coming. A password that cannot be set cannot
// be reused from a site that gets breached, which is the realistic way someone
// loses a finance account.
//
// A code rather than a link because the whole flow stays in this tab. A magic
// link opened from a phone's mail app lands in that app's webview — you end up
// signed in somewhere you weren't, and the tab you started in is still logged
// out. Typing six digits is a second of friction that removes the entire class
// of problem, and it is the pattern every bank here has already taught people.

const CODE_LENGTH = 6;

export default function SignInForm({
  googleEnabled,
  callbackURL = '/',
}: {
  googleEnabled: boolean;
  callbackURL?: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resentAt, setResentAt] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === 'code') codeInput.current?.focus();
  }, [step]);

  const requestCode = (resend = false) => {
    setError(null);
    startTransition(async () => {
      const { error: failure } = await authClient.emailOtp.sendVerificationOtp({
        email: email.trim(),
        type: 'sign-in',
      });
      if (failure) {
        setError(failure.message ?? 'Could not send the code. Try again in a moment.');
        return;
      }
      setStep('code');
      if (resend) setResentAt(Date.now());
    });
  };

  const verify = (value: string) => {
    setError(null);
    startTransition(async () => {
      const { error: failure } = await authClient.signIn.emailOtp({ email: email.trim(), otp: value });
      if (failure) {
        // Deliberately vague: "no such account" tells a stranger which addresses
        // are registered here.
        setError(failure.message ?? 'That code is wrong or has expired.');
        setCode('');
        codeInput.current?.focus();
        return;
      }
      // A full refresh, not just a push: every Server Component on the next
      // page reads the session, and the merged ledger is what they should see.
      router.push(callbackURL);
      router.refresh();
    });
  };

  if (step === 'code') {
    return (
      <div className="card space-y-4 p-6">
        <div>
          <h2 className="text-sm font-semibold">Enter the code</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-dim">
            Six digits, sent to <strong className="font-medium text-ink">{email}</strong>. It works
            once and expires in ten minutes.
          </p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            verify(code);
          }}
          className="space-y-2"
        >
          <input
            ref={codeInput}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d*"
            maxLength={CODE_LENGTH}
            aria-label="Sign-in code"
            value={code}
            onChange={(event) => {
              const next = event.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
              setCode(next);
              // Submitting itself once it's complete: nobody wants to type six
              // digits and then hunt for a button.
              if (next.length === CODE_LENGTH && !pending) verify(next);
            }}
            className="w-full rounded-lg border border-line bg-surface px-3 py-3 text-center text-2xl tracking-[0.5em] tnum outline-none transition-colors placeholder:tracking-normal placeholder:text-base placeholder:text-ink-faint focus:border-accent-dim"
            placeholder="000000"
          />

          <button
            type="submit"
            disabled={pending || code.length !== CODE_LENGTH}
            className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:bg-line-strong disabled:text-ink-faint"
          >
            {pending ? 'Checking…' : 'Sign in'}
          </button>
        </form>

        {error && (
          <p role="alert" className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between text-xs">
          <button
            type="button"
            onClick={() => {
              setStep('email');
              setCode('');
              setError(null);
            }}
            className="text-ink-faint hover:text-ink"
          >
            ← Different address
          </button>
          <button
            type="button"
            onClick={() => requestCode(true)}
            disabled={pending}
            className="text-accent hover:underline disabled:opacity-50"
          >
            {resentAt ? 'Sent again' : 'Resend'}
          </button>
        </div>
      </div>
    );
  }

  const withGoogle = () => {
    setError(null);
    startTransition(async () => {
      const { error: failure } = await authClient.signIn.social({ provider: 'google', callbackURL });
      if (failure) setError(failure.message ?? 'Could not reach Google. Try again in a moment.');
    });
  };

  return (
    <div className="card space-y-4 p-6">
      {googleEnabled && (
        <>
          <button
            type="button"
            onClick={withGoogle}
            disabled={pending}
            className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-medium transition-colors hover:border-line-strong disabled:opacity-50"
          >
            <GoogleMark />
            Continue with Google
          </button>

          <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-ink-faint">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          requestCode();
        }}
        className="space-y-2"
      >
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-faint">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-accent-dim"
          />
        </label>

        <button
          type="submit"
          disabled={pending || email.trim().length === 0}
          className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:bg-line-strong disabled:text-ink-faint"
        >
          {pending ? 'Sending…' : 'Email me a code'}
        </button>
      </form>

      {error && (
        <p role="alert" className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-ink-faint">
        No password — we send a six-digit code instead. Anything you have already logged stays
        yours: it moves onto your account the moment you sign in.
      </p>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 18 18" className="size-4">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}
