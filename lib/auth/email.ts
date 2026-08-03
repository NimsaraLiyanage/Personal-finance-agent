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

export async function sendSignInCode(
  email: string,
  code: string,
  type: CodeType = 'sign-in',
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('RESEND_API_KEY is not set — cannot send sign-in codes');
    }
    console.info(`\n[auth] ${type} code for ${email}: ${code}\n`);
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
    console.error('[auth] code send failed:', response.status, detail.slice(0, 300));
    // Surfaced to the caller: "check your email" is a lie if nothing was sent.
    throw new Error('Could not send the code.');
  }
}
