// The weekly briefing — the agent speaking without being asked.
//
// This is the piece that separates a tracker from an assistant. Every expense
// app can draw you a chart; the reason people abandon them within a month is
// that the chart shows what happened and never says what to do about it. So
// once a week the agent reads the ledger, decides what actually matters, and
// writes three paragraphs about it.
//
// Division of labour, and it is not negotiable:
//   - `facts.ts` computes every number, in code, from the database.
//   - the model chooses what is worth mentioning and writes the sentences.
// The model is never asked to calculate anything. See facts.ts for why.

import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { prisma } from '../db';
import { buildChatModel, type AgentLlm } from '../agent/model';
import { contentToText } from '../agent/graph';
import { formatDateInZone } from '../agent/time';
import type { LedgerScope } from '../finance/queries';
import { gatherBriefingFacts, type BriefingFacts } from './facts';

const BRIEFING_PROMPT = `
You are Tally, a personal finance assistant, writing this week's briefing for
the one person whose ledger you keep. They did not ask for it — you are bringing
it to them — so it has to earn its place in about fifteen seconds of reading.

## The hard rule
Every number you write MUST be copied verbatim from the FACTS block. Do not
calculate, re-round, convert, or estimate anything. If a figure you want is not
in FACTS, do not mention it. Percentages are only usable when FACTS gives them.

## What to write
A headline of at most 60 characters, then 2–4 short paragraphs.

Lead with whatever a reasonable person would most want to know — usually the
biggest change, a budget about to break, or a projection that lands badly. Then
one or two supporting observations.

Recurring charges are worth a sentence, but rank them by what CHANGED, not by
size. A subscription whose price moved, or one that has stopped arriving after
months of turning up, is news. "You still pay for Netflix" is not — they know.
Never guess why something stopped; say it stopped and let them tell you.

End with one concrete, small thing they could do, only if the data supports one.
No suggestion is better than an invented one.

## Voice
Direct, warm, unfussy — a competent friend who is good with money. No
exclamation marks, no "Great job!", no motivational filler, no greeting, no
sign-off. When they overspent, say so plainly and without moralising; it is
their money. When the week was unremarkable, say that in two sentences rather
than inflating it into four.

Never give investment advice or interpret tax law.

## Output format
Return JSON exactly like:
{"headline": "...", "body": "First paragraph.\\n\\nSecond paragraph."}
Paragraphs in \`body\` are separated by a blank line. No markdown headings, no
bullet lists.
`.trim();

export interface BriefingResult {
  id: string;
  headline: string;
  body: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  /** Null until the reader dismisses it. */
  readAt: string | null;
}

/** ISO-week key, so re-running the job on the same week is a no-op. */
export function weeklyDedupeKey(scope: LedgerScope): string {
  const day = formatDateInZone(scope.now, scope.timezone);
  const date = new Date(`${day}T00:00:00Z`);
  // ISO weeks run Monday–Sunday and belong to the year containing the Thursday.
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((thursday.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `weekly-${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Write this week's briefing, or return the existing one.
 *
 * Returns null when there is nothing to say — a week with no transactions gets
 * silence, not a paragraph explaining that nothing happened. An assistant that
 * speaks every week regardless of whether it has anything to contribute is one
 * people learn to ignore.
 */
export async function generateWeeklyBriefing(
  scope: LedgerScope,
  options: { force?: boolean; modelFactory?: () => AgentLlm } = {},
): Promise<BriefingResult | null> {
  const dedupeKey = weeklyDedupeKey(scope);

  if (!options.force) {
    const existing = await prisma.insight.findUnique({
      where: { userId_dedupeKey: { userId: scope.userId, dedupeKey } },
    });
    if (existing) return toResult(existing);
  }

  const facts = await gatherBriefingFacts(scope);
  if (facts.quiet) return null;

  const model = (options.modelFactory ?? buildChatModel)();
  const response = await model.invoke([
    new SystemMessage(BRIEFING_PROMPT),
    new HumanMessage(`FACTS\n${JSON.stringify(facts, null, 2)}`),
  ]);

  const written = parseBriefing(contentToText(response.content));
  if (!written) return null;

  const { start, end } = coveredWindow(facts, scope);

  const saved = await prisma.insight.upsert({
    where: { userId_dedupeKey: { userId: scope.userId, dedupeKey } },
    create: {
      userId: scope.userId,
      kind: 'weekly_briefing',
      periodStart: start,
      periodEnd: end,
      headline: written.headline,
      body: written.body,
      facts: facts as unknown as never,
      dedupeKey,
    },
    update: {
      headline: written.headline,
      body: written.body,
      facts: facts as unknown as never,
      readAt: null,
    },
  });

  return toResult(saved);
}

/** The most recent briefing, whether or not it has been read. */
export async function latestBriefing(userId: string): Promise<BriefingResult | null> {
  const row = await prisma.insight.findFirst({
    where: { userId, kind: 'weekly_briefing' },
    orderBy: { createdAt: 'desc' },
  });
  return row ? toResult(row) : null;
}

export async function markInsightRead(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.insight.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  });
  return count > 0;
}

// ── Internals ───────────────────────────────────────────────────────────────

function toResult(row: {
  id: string;
  headline: string;
  body: string;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  readAt: Date | null;
}): BriefingResult {
  return {
    id: row.id,
    headline: row.headline,
    body: row.body,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

function coveredWindow(_facts: BriefingFacts, scope: LedgerScope) {
  const end = scope.now;
  return { start: new Date(end.getTime() - 7 * 86_400_000), end };
}

/**
 * Pull the headline and body out of the model's reply.
 *
 * Tolerates a fenced code block around the JSON, and falls back to treating the
 * first line as a headline — a briefing that arrives slightly malformed is
 * still worth showing, but one that throws is a job that silently stops running.
 */
function parseBriefing(raw: string): { headline: string; body: string } | null {
  const text = raw.trim();
  if (!text) return null;

  const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(json) as { headline?: unknown; body?: unknown };
    if (typeof parsed.headline === 'string' && typeof parsed.body === 'string') {
      const headline = parsed.headline.trim().slice(0, 120);
      const body = parsed.body.trim();
      if (headline && body) return { headline, body };
    }
  } catch {
    // Fall through to the plain-text reading.
  }

  const [first, ...rest] = text.split('\n');
  const body = rest.join('\n').trim();
  if (!body) return null;
  return { headline: first.replace(/^#+\s*/, '').slice(0, 120), body };
}
