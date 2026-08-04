// Sending the sign-in code.
//
// Resend when it is configured, the server log when it is not. The fallback is
// deliberate rather than lazy: a fresh clone of this repo can be signed into
// with no accounts to create anywhere, and the code is right there in the
// terminal. It refuses in production, where a code printed to a log is a code
// in whatever aggregates the logs.

const FROM = process.env.EMAIL_FROM?.trim() || 'Tally <onboarding@resend.dev>';

type CodeType = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';

const SUBJECTS: Record<CodeType, string> = {
  'sign-in': 'Your Tally sign-in code',
  'email-verification': 'Verify your email for Tally',
  'forget-password': 'Your Tally reset code',
  'change-email': 'Confirm your new Tally email',
};

const isProduction = process.env.NODE_ENV === 'production';

/** Development only: the code goes where the developer can see it. */
function logCode(email: string, code: string, type: CodeType, why?: string) {
  console.info(
    `\n[auth] ${type} code for ${email}: ${code}${why ? `\n[auth] (email not sent: ${why})` : ''}\n`,
  );
}

export async function sendSignInCode(
  email: string,
  code: string,
  type: CodeType = 'sign-in',
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    if (isProduction) {
      throw new Error('RESEND_API_KEY is not set — cannot send sign-in codes');
    }
    logCode(email, code, type);
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: email,
      subject: SUBJECTS[type],
      text: [
        `Your Tally code is ${code}`,
        '',
        'It expires in 10 minutes and works once.',
        "If you didn't ask for it, ignore this — a code on its own does nothing.",
      ].join('\n'),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const reason = extractReason(detail) ?? `HTTP ${response.status}`;

    // In development the send is allowed to fail and the flow carries on with
    // the code in the terminal. The most common failure is not a bug at all:
    // Resend's sandbox sender only delivers to the account owner's own address,
    // so testing a second account looks like a broken app when it is a provider
    // rule. Blocking sign-in on that would make the feature untestable.
    if (!isProduction) {
      console.error('[auth] code send failed:', response.status, detail.slice(0, 300));
      logCode(email, code, type, reason);
      return;
    }

    console.error('[auth] code send failed:', response.status, detail.slice(0, 300));
    // Surfaced to the caller: "check your email" is a lie if nothing was sent.
    throw new Error('Could not send the code.');
  }
}

/** Pull the human sentence out of a provider error body, if there is one. */
function extractReason(detail: string): string | null {
  try {
    const parsed = JSON.parse(detail) as { message?: string };
    return parsed.message?.slice(0, 200) ?? null;
  } catch {
    return detail ? detail.slice(0, 200) : null;
  }
}
