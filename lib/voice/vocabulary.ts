// Transcription bias — telling the speech model which words to expect.
//
// Short utterances are where speech recognition is weakest, and "kadeta gihin
// pansiiyak gaththa" is about as short and as far from the training
// distribution as it gets. The transcription APIs take a `prompt` that biases
// decoding toward a supplied vocabulary, which is the difference between
// hearing "Keells" and hearing "kills".
//
// Two sources, in order of usefulness:
//   1. Words this person actually uses — their category names and the merchants
//      already in their ledger. Nothing generic beats that.
//   2. A static hint for the language itself, since Sinhala numerals and
//      Singlish spending verbs are not in a general model's comfort zone.
//
// Server-only: it reads the database, so it must never be pulled into the
// client bundle. Keep it out of lib/voice/pipeline.ts, which the browser
// controller imports.

import { prisma } from '../db';

/**
 * The default language hint. Overridable with OPENAI_TRANSCRIBE_PROMPT for a
 * deployment aimed somewhere else.
 */
const DEFAULT_HINT = [
  'Sinhala and English mixed.',
  'Amounts: seeyak, pan-seeyak, dahak, pan-dahak, lakshayak, rupees.',
  'Words: kade, bus eka, trishaw, kaema, kuliya, badu, gaththa, gewwa, hambuna.',
].join(' ');

/** Prompts are charged and slow things down past a point. */
const MAX_CHARS = 900;

export async function transcriptionBias(userId: string | null): Promise<string> {
  const hint = process.env.OPENAI_TRANSCRIBE_PROMPT?.trim() || DEFAULT_HINT;
  if (!userId) return hint;

  try {
    const [categories, merchants] = await Promise.all([
      prisma.category.findMany({
        where: { userId, archivedAt: null },
        select: { label: true },
      }),
      // Distinct merchants, most recent first — what they say now matters more
      // than what they said a year ago.
      prisma.transaction.findMany({
        where: { userId, merchant: { not: null } },
        orderBy: { occurredAt: 'desc' },
        select: { merchant: true },
        distinct: ['merchant'],
        take: 40,
      }),
    ]);

    const words = [
      ...categories.map((c) => c.label),
      ...merchants.map((m) => m.merchant!).filter(Boolean),
    ];

    if (words.length === 0) return hint;
    return `${hint} Names: ${words.join(', ')}.`.slice(0, MAX_CHARS);
  } catch {
    // A bias prompt is an optimisation. Never fail a transcription over it.
    return hint;
  }
}
