// Bank SMS → ledger entries.
//
// This is the hard half of "read my bank messages". On Android, listening for
// SMS is a permission and forty lines of glue; understanding what the message
// SAYS is the actual work, and every issuer writes it differently:
//
//   Your Card No.4512XXXXXXXX7890 was used for a purchase of LKR 2,500.00 at
//   KEELLS SUPER on 03/08/2026 14:23. Avl Bal LKR 45,300.00
//
//   Sampath Bank: A/C XXXX5678 debited LKR 3,000.00 on 03/08/26 for FUND
//   TRANSFER. Bal LKR 12,400.00
//
//   BOC: Rs.1,500.00 credited to A/C XXX1234 - SALARY JULY
//
// So the parser is written as LAYERS rather than one template per bank: find
// the amount, decide which way the money went, find the counterparty, find the
// date. A bank we have never seen still parses if it writes English sentences
// about money, and a bank we do know just scores higher confidence.
//
// ── This file is deliberately pure ──────────────────────────────────────────
// No database, no `next/*`, no `Date.now()`, no Node built-ins. It takes a
// string and a reference date and returns plain objects. That is what lets the
// same file ship inside a React Native app later, and — more immediately — what
// lets the browser show a live preview while you paste, with the server
// re-running the identical code before anything is written. The client renders
// the interpretation; it never gets to decide the numbers.

// ── Types ───────────────────────────────────────────────────────────────────

export interface ParsedMessage {
  /** The message exactly as pasted. The server re-parses from this. */
  raw: string;
  kind: 'expense' | 'income';
  amountMinor: number;
  /** What the message itself said, which may not be the ledger's currency. */
  currency: string;
  merchant: string | null;
  /** YYYY-MM-DD, or null when the message never said — caller uses today. */
  occurredOn: string | null;
  /** HH:MM, 24h. Display only; the ledger stores days. */
  occurredAtTime: string | null;
  /** Last 4 of the card or account, when the message shows a masked one. */
  accountTail: string | null;
  issuer: { id: string; label: string } | null;
  /** Best guess. Always overridable in review, and a user rule beats it. */
  category: string;
  /**
   * Cash leaving an account rather than being spent. The caller turns this
   * into a transfer when the person has a cash account to move it to — see
   * app/actions/import.ts.
   */
  cashWithdrawal: boolean;
  /** 0–1. Below LOW_CONFIDENCE the row arrives unticked. */
  confidence: number;
  /** Things a person should know before ticking the box. */
  notes: string[];
  /** Stable identity of THIS message, for not importing it twice. */
  fingerprint: string;
}

export interface RejectedMessage {
  raw: string;
  reason: string;
}

export interface ParseReport {
  parsed: ParsedMessage[];
  rejected: RejectedMessage[];
}

export interface ParseOptions {
  /** Currency to assume when the message names none. */
  currency?: string;
  /** Today, as YYYY-MM-DD in the user's zone. Keeps this function pure. */
  today?: string;
}

/** Under this, we don't tick the box for you. */
export const LOW_CONFIDENCE = 0.55;

// ── Issuers ─────────────────────────────────────────────────────────────────
// Recognising the sender doesn't change the parse — it raises confidence and
// gives the review table something to show. Adding a bank is one line.

const ISSUERS: Array<{ id: string; label: string; patterns: RegExp[] }> = [
  { id: 'combank', label: 'Commercial Bank', patterns: [/\bcombank\b/i, /commercial bank/i] },
  { id: 'sampath', label: 'Sampath Bank', patterns: [/\bsampath\b/i, /\bvishwa\b/i] },
  { id: 'hnb', label: 'HNB', patterns: [/\bhnb\b/i, /hatton national/i] },
  { id: 'boc', label: 'Bank of Ceylon', patterns: [/\bboc\b/i, /bank of ceylon/i, /\bsmartpay\b/i] },
  { id: 'peoples', label: "People's Bank", patterns: [/people'?s bank/i, /\bpeoples ?wave\b/i] },
  { id: 'ndb', label: 'NDB', patterns: [/\bndb\b/i, /national development bank/i, /\bneos\b/i] },
  { id: 'seylan', label: 'Seylan Bank', patterns: [/\bseylan\b/i] },
  { id: 'ntb', label: 'Nations Trust', patterns: [/\bntb\b/i, /nations trust/i, /\bamex\b/i] },
  { id: 'dfcc', label: 'DFCC Bank', patterns: [/\bdfcc\b/i] },
  { id: 'panasia', label: 'Pan Asia Bank', patterns: [/pan ?asia/i] },
  { id: 'unionbank', label: 'Union Bank', patterns: [/union bank/i] },
  { id: 'amana', label: 'Amana Bank', patterns: [/\bamana\b/i] },
  { id: 'frimi', label: 'FriMi', patterns: [/\bfrimi\b/i] },
  { id: 'ezcash', label: 'eZ Cash', patterns: [/\bez ?cash\b/i] },
  { id: 'mcash', label: 'mCash', patterns: [/\bmcash\b/i] },
  { id: 'genie', label: 'Genie', patterns: [/\bgenie\b/i] },
  { id: 'helapay', label: 'HelaPay', patterns: [/\bhelapay\b/i] },
];

function detectIssuer(text: string) {
  for (const issuer of ISSUERS) {
    if (issuer.patterns.some((p) => p.test(text))) {
      return { id: issuer.id, label: issuer.label };
    }
  }
  return null;
}

// ── Amounts ─────────────────────────────────────────────────────────────────

const CURRENCY_WORD = String.raw`LKR|Rs\.?|රු\.?|₨|US\$|USD|EUR|GBP|INR|SGD|AUD|\$|€|£|rupees?`;
// Two shapes, and the grouped one MUST come first: Sri Lankan grouping is
// 2-2-3 ("1,25,000.00"), not just 3s. The `+` matters — with `*`, the grouped
// branch would match "125" out of an ungrouped "12500" and quietly turn twelve
// thousand rupees into a hundred and twenty five.
const NUMBER = String.raw`\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;

const AMOUNT_RE = new RegExp(
  String.raw`(?:(${CURRENCY_WORD})\s*(${NUMBER})|(${NUMBER})\s*(${CURRENCY_WORD}))`,
  'gi',
);

const CURRENCY_ALIASES: Array<[RegExp, string]> = [
  [/^(?:lkr|rs\.?|රු\.?|₨|rupees?)$/i, 'LKR'],
  [/^(?:us\$|usd|\$)$/i, 'USD'],
  [/^(?:eur|€)$/i, 'EUR'],
  [/^(?:gbp|£)$/i, 'GBP'],
  [/^inr$/i, 'INR'],
  [/^sgd$/i, 'SGD'],
  [/^aud$/i, 'AUD'],
];

function normaliseCurrency(token: string, fallback: string): string {
  const trimmed = token.trim();
  for (const [pattern, code] of CURRENCY_ALIASES) {
    if (pattern.test(trimmed)) return code;
  }
  return fallback;
}

/**
 * The single most important rule in this file: **a balance is not a
 * transaction.** Nearly every bank SMS ends with "Avl Bal LKR 45,300.00", and a
 * parser that grabs the last number turns a Rs 250 tea into a Rs 45,300 one.
 */
const BALANCE_CONTEXT =
  /\b(?:bal|balance|avl|avbl|available|limit|outstanding|minimum|remaining|o\/s)\b[^,;]{0,24}$/i;

interface AmountHit {
  start: number;
  end: number;
  amount: number;
  currency: string;
  isBalance: boolean;
}

function findAmounts(text: string, fallbackCurrency: string): AmountHit[] {
  const hits: AmountHit[] = [];
  AMOUNT_RE.lastIndex = 0;

  for (let m = AMOUNT_RE.exec(text); m; m = AMOUNT_RE.exec(text)) {
    const token = m[1] ?? m[4] ?? '';
    const digits = m[2] ?? m[3] ?? '';
    const amount = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(amount)) continue;

    // Look back a short way for the word that makes this a balance.
    const lead = text.slice(Math.max(0, m.index - 30), m.index);

    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      amount,
      currency: normaliseCurrency(token, fallbackCurrency),
      isBalance: BALANCE_CONTEXT.test(lead) || amount === 0,
    });
  }

  return hits;
}

// ── Direction ───────────────────────────────────────────────────────────────

const DEBIT_SIGNALS: Array<[RegExp, number]> = [
  [/\bdebited\b/i, 4],
  [/\bdebit\b/i, 2],
  [/\bpurchas(?:e|ed|ing)\b/i, 3],
  [/\bspent\b/i, 3],
  [/\bpaid\b|\bpayment\b/i, 3],
  [/\bwithdraw(?:n|al|als)?\b/i, 4],
  [/\bwas used\b|\bused for\b|\bused at\b/i, 3],
  [/\bcharged\b/i, 2],
  [/\bdeducted\b/i, 4],
  [/\btransferred to\b|\bsent to\b/i, 3],
  [/\bsent\b/i, 2],
  [/\bpos\b|\batm\b/i, 1],
];

const CREDIT_SIGNALS: Array<[RegExp, number]> = [
  [/\bcredited\b/i, 4],
  [/\breceived\b/i, 3],
  [/\bdeposit(?:ed)?\b/i, 4],
  [/\bsalary\b|\bpayroll\b|\bwages\b/i, 3],
  // A refund is a purchase running backwards, so it has to outweigh the
  // "purchase" the message is almost certainly also carrying.
  [/\brefund(?:ed)?\b/i, 5],
  [/\brevers(?:ed|al)\b/i, 5],
  [/\bcashback\b/i, 4],
  [/\btransferred from\b|\breceived from\b|\bfrom\b.{0,20}\bcredited\b/i, 3],
  [/\bincoming\b/i, 2],
];

function score(text: string, signals: Array<[RegExp, number]>): number {
  return signals.reduce((total, [pattern, weight]) => total + (pattern.test(text) ? weight : 0), 0);
}

/**
 * "Credit card" is not a credit. Neither is "credit limit". These phrases sit
 * in a large share of spending messages, and left alone they flip a purchase
 * into income — so they are spent before the scoring runs.
 */
function neutralise(text: string): string {
  return text
    .replace(/\bcredit\s*card\b/gi, 'card')
    .replace(/\bdebit\s*card\b/gi, 'card')
    .replace(/\bcredit\s*limit\b/gi, 'limit')
    .replace(/\bcard\s*no\b/gi, 'card');
}

// ── Dates ───────────────────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_WORD = Object.keys(MONTH_NAMES).join('|');

interface DateHit {
  start: number;
  end: number;
  iso: string;
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Two digits mean this century. Banks do not send SMS about 1926. */
function expandYear(value: number): number {
  return value < 100 ? 2000 + value : value;
}

/**
 * Find the transaction date.
 *
 * **Day-first.** `03/08/2026` is the third of August, because that is what it
 * means everywhere these messages are sent. Month-first is used only when the
 * numbers force it (`08/23/2026` can't be a 23rd month).
 */
function findDate(text: string, todayIso: string): DateHit | null {
  const [ty, tm, td] = todayIso.split('-').map(Number);
  const todayValue = ty * 10000 + tm * 100 + td;

  const accept = (start: number, end: number, y: number, m: number, d: number): DateHit | null => {
    if (!isRealDate(y, m, d)) return null;
    return { start, end, iso: iso(y, m, d) };
  };

  // ISO first — unambiguous, so nothing else should get a chance at it.
  const isoMatch = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (isoMatch) {
    const hit = accept(
      isoMatch.index,
      isoMatch.index + isoMatch[0].length,
      Number(isoMatch[1]),
      Number(isoMatch[2]),
      Number(isoMatch[3]),
    );
    if (hit) return hit;
  }

  // 03/08/2026 · 03-08-26 · 03.08.2026
  const numeric = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/.exec(text);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = expandYear(Number(numeric[3]));
    // Only a value above 12 can settle the order. Otherwise: day first.
    const [day, month] = a > 12 || b <= 12 ? [a, b] : [b, a];
    const hit = accept(numeric.index, numeric.index + numeric[0].length, year, month, day);
    if (hit) return hit;
  }

  // 03 Aug 2026 · 3rd August · 03Aug26
  const dayMonth = new RegExp(
    String.raw`\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/]*(${MONTH_WORD})[a-z]*\.?[\s\-/,]*(\d{2,4})?\b`,
    'i',
  ).exec(text);
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const month = MONTH_NAMES[dayMonth[2].toLowerCase()];
    const hit = resolveWithoutYear(
      dayMonth.index,
      dayMonth.index + dayMonth[0].length,
      month,
      day,
      dayMonth[3] ? expandYear(Number(dayMonth[3])) : null,
      ty,
      todayValue,
    );
    if (hit) return hit;
  }

  // Aug 03, 2026
  const monthDay = new RegExp(
    String.raw`\b(${MONTH_WORD})[a-z]*\.?[\s\-/]+(\d{1,2})(?:st|nd|rd|th)?[\s\-/,]*(\d{2,4})?\b`,
    'i',
  ).exec(text);
  if (monthDay) {
    const month = MONTH_NAMES[monthDay[1].toLowerCase()];
    const day = Number(monthDay[2]);
    const hit = resolveWithoutYear(
      monthDay.index,
      monthDay.index + monthDay[0].length,
      month,
      day,
      monthDay[3] ? expandYear(Number(monthDay[3])) : null,
      ty,
      todayValue,
    );
    if (hit) return hit;
  }

  return null;
}

/**
 * "12 Aug" with no year means this year — unless that lands in the future, in
 * which case it means last year. A December message read in January is the
 * common case and it should not date itself eleven months ahead.
 */
function resolveWithoutYear(
  start: number,
  end: number,
  month: number,
  day: number,
  statedYear: number | null,
  currentYear: number,
  todayValue: number,
): DateHit | null {
  const year = statedYear ?? (month * 100 + day > todayValue % 10000 ? currentYear - 1 : currentYear);
  if (!isRealDate(year, month, day)) return null;
  return { start, end, iso: iso(year, month, day) };
}

const TIME_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)(?::[0-5]\d)?\s*([ap]\.?m\.?)?/i;

function findTime(text: string): { start: number; end: number; value: string } | null {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2];
  const meridiem = m[3]?.toLowerCase().replace(/\./g, '');
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return {
    start: m.index,
    end: m.index + m[0].length,
    value: `${String(hour).padStart(2, '0')}:${minute}`,
  };
}

// ── Card / account ──────────────────────────────────────────────────────────

const ACCOUNT_RE =
  /\b(?:card|a\/c|acct?|account)\s*(?:no\.?|number|ending(?:\s+in)?|#)?\s*[:\-]?\s*((?:[x*•]|\d)[\dx*•\s-]{3,22})/i;

function findAccount(text: string): { start: number; end: number; tail: string } | null {
  const m = ACCOUNT_RE.exec(text);
  if (!m) return null;
  const digits = m[1].replace(/\D/g, '');
  if (digits.length < 4) return null;
  return { start: m.index, end: m.index + m[0].length, tail: digits.slice(-4) };
}

// ── Merchant ────────────────────────────────────────────────────────────────

const MERCHANT_STOPWORDS =
  /^(?:the\s+)?(?:balance|amount|acc(?:ount)?|a\/c|card|atm|pos|your|you|use|purchase|transaction|payment|this|it|be|us|our)\b/i;

function cleanMerchant(value: string): string | null {
  let out = value
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:on|at|from|dated)\s*$/i, '')
    .replace(/[\s.,;:\-*#]+$/, '')
    .replace(/^[\s.,;:\-*#]+/, '')
    .trim();

  // POS descriptors trail a country code and city noise.
  out = out.replace(/\s+(?:LK|LKA|SRI LANKA)$/i, '').trim();

  if (out.length < 2 || out.length > 48) return null;
  if (MERCHANT_STOPWORDS.test(out)) return null;
  // A bare 1–2 digit leftover is a fragment, not a name. Phone numbers, which
  // are how a wallet transfer names its counterparty, are worth keeping.
  if (/^\d{1,3}$/.test(out)) return null;

  return titleCaseIfShouting(out);
}

/** POS terminals shout. "KEELLS SUPER" reads better as "Keells Super". */
function titleCaseIfShouting(value: string): string {
  if (value !== value.toUpperCase()) return value;
  return value
    .toLowerCase()
    .split(' ')
    // One- and two-letter tokens stay upper: "LK", "JB". Anything longer is far
    // more often a word than an initialism.
    .map((word) => (word.length > 2 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toUpperCase()))
    .join(' ');
}

function findMerchant(masked: string, kind: 'expense' | 'income'): string | null {
  const patterns =
    kind === 'income'
      ? [/\bfrom\s+([^,.;\n]{2,48})/i, /\bby\s+([^,.;\n]{2,48})/i, /\bat\s+([^,.;\n]{2,48})/i, /\bfor\s+([^,.;\n]{2,48})/i]
      : [/\bat\s+([^,.;\n]{2,48})/i, /\bto\s+([^,.;\n]{2,48})/i, /\bfor\s+([^,.;\n]{2,48})/i, /\bfrom\s+([^,.;\n]{2,48})/i];

  for (const pattern of patterns) {
    const m = pattern.exec(masked);
    if (!m) continue;
    const cleaned = cleanMerchant(m[1]);
    if (cleaned) return cleaned;
  }
  return null;
}

// ── Category guessing ───────────────────────────────────────────────────────
// A first guess only. A learned rule from lib/finance/categories.ts overrides
// this server-side, and the review table lets anyone change it before saving —
// so being wrong here costs a dropdown, not a bad ledger.

const MERCHANT_CATEGORIES: Array<[RegExp, string]> = [
  // Ordered: the specific case must win over the general one it contains.
  [/uber\s*eats|pickme\s*food|ubereats|food\s*delivery/i, 'dining'],
  [/netflix|spotify|disney|prime\s*video|youtube\s*premium|icloud|google\s*one|apple\.com\/bill|adobe|chatgpt|openai/i, 'subscriptions'],
  [/keells|cargills|food\s*city|arpico|glomark|sathosa|spar|laugfs\s*super|super\s*?market|grocery|supermart/i, 'groceries'],
  [/kfc|mcdonald|pizza\s*hut|dominos|burger|subway|cafe|coffee|barista|starbucks|java\s*lounge|restaurant|bakers|perera\s*&?\s*sons|dinemore|kottu|hotel\b|bake\s*house/i, 'dining'],
  [/pickme|\buber\b|taxi|tuk|three\s*wheel|\bbus\b|railway|ceypetco|lanka\s*ioc|\bioc\b|sinopec|petrol|fuel|filling\s*station|parking|expressway/i, 'transport'],
  [/\bceb\b|\bleco\b|water\s*board|nwsdb|\bslt\b|mobitel|dialog|hutch|airtel|electricity|broadband|recharge|reload|prepaid|postpaid|\bpeo\s*tv\b/i, 'utilities'],
  [/pharmacy|osu\s*sala|healthguard|nawaloka|asiri|durdans|lanka\s*hospital|hemas|medical|dental|channel(?:ing)?\s*centre|labor(?:atory|atories)/i, 'health'],
  [/odel|house\s*of\s*fashion|nolimit|no\s*limit|cool\s*planet|fashion\s*bug|kelly\s*felder|daraz|ikman|amazon|aliexpress|shein|\bmall\b|clothing/i, 'shopping'],
  [/cinema|savoy|scope|liberty\s*by|steam\s*games|playstation|xbox|nintendo/i, 'entertainment'],
  [/campus|institute|university|\bschool\b|tuition|\bsliit\b|\bnsbm\b|\biit\b|academy|course\s*fee/i, 'education'],
  [/\brent\b|kuliya|lease|landlord|apartment|maintenance\s*fee/i, 'housing'],
  [/fixed\s*deposit|\bfd\b|savings\s*transfer|investment/i, 'savings'],
];

export function guessCategory(
  kind: 'expense' | 'income',
  merchant: string | null,
  fullText: string,
): string {
  if (kind === 'income') return 'income';

  const haystack = `${merchant ?? ''} ${fullText}`;
  for (const [pattern, category] of MERCHANT_CATEGORIES) {
    if (pattern.test(haystack)) return category;
  }
  return 'other';
}

// ── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * A stable id for a message, so re-pasting an overlapping range doesn't
 * double-count. FNV-1a in two lanes: not cryptographic, it only has to be
 * deterministic across the browser, the server and (later) a phone — which
 * rules out `node:crypto`.
 *
 * It hashes the MESSAGE, not our reading of it. Interpretation can improve in
 * a later release; the identity of "this SMS" must not move when it does.
 */
export function fingerprint(raw: string): string {
  const normal = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < normal.length; i++) {
    const c = normal.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ── Splitting a paste into messages ─────────────────────────────────────────

const AMOUNT_PROBE = new RegExp(String.raw`(?:${CURRENCY_WORD})\s*\d|\d\s*(?:${CURRENCY_WORD})`, 'i');
const MONEY_VERB =
  /\b(debit|credit|purchas|spent|paid|payment|withdraw|deposit|received|refund|revers|transfer|sent|charged|deducted|used)/i;

/** Cheap test used only to decide where one message ends and the next begins. */
function looksLikeMessage(line: string): boolean {
  return AMOUNT_PROBE.test(line) && MONEY_VERB.test(line);
}

/**
 * Split a paste into individual messages.
 *
 * People paste two ways: blank lines between messages, or one message per
 * line. Blank lines win when present; otherwise a block is split per line only
 * when every line independently looks like a message of its own — which stops
 * a genuinely multi-line SMS from being torn into fragments.
 */
export function splitMessages(input: string): string[] {
  const blocks = input
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every(looksLikeMessage)) out.push(...lines);
    else out.push(block);
  }
  return out;
}

// ── The parser ──────────────────────────────────────────────────────────────

const OTP_PATTERNS = [
  /\botp\b/i,
  /one[\s-]?time\s*(?:password|pin|code)/i,
  /verification code/i,
  /\bdo not (?:share|disclose)\b/i,
];

/** Blank out a span while keeping every other character at its own index. */
function mask(text: string, ranges: Array<{ start: number; end: number }>): string {
  const chars = text.split('');
  for (const range of ranges) {
    for (let i = range.start; i < range.end && i < chars.length; i++) chars[i] = ' ';
  }
  return chars.join('');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseMessage(
  raw: string,
  options: ParseOptions = {},
): ParsedMessage | RejectedMessage {
  const text = raw.replace(/\s+/g, ' ').trim();
  const fallbackCurrency = (options.currency ?? 'LKR').toUpperCase();
  const todayIso = options.today ?? new Date().toISOString().slice(0, 10);

  if (!text) return { raw, reason: 'Empty message.' };

  if (OTP_PATTERNS.some((p) => p.test(text))) {
    return { raw, reason: 'Looks like a one-time password, not a transaction.' };
  }

  const amounts = findAmounts(text, fallbackCurrency);
  const spendable = amounts.filter((a) => !a.isBalance);

  if (spendable.length === 0) {
    return {
      raw,
      reason: amounts.length > 0
        ? 'Only a balance in this one — no money moved.'
        : 'No amount found.',
    };
  }

  // Banks lead with the transaction and trail with the balance, so first wins.
  const chosen = spendable[0];
  const notes: string[] = [];

  const scored = neutralise(text);
  const debit = score(scored, DEBIT_SIGNALS);
  const credit = score(scored, CREDIT_SIGNALS);

  if (debit === 0 && credit === 0) {
    return { raw, reason: 'Nothing here says money moved in or out.' };
  }

  const kind: 'expense' | 'income' = credit > debit ? 'income' : 'expense';
  const margin = Math.abs(credit - debit);
  if (margin === 0) {
    notes.push('Could read either way — assumed an expense. Check before saving.');
  }

  // Mask what we have already understood, so the merchant search can't pick up
  // a date or a card number and call it a shop.
  const claimed: Array<{ start: number; end: number }> = [...amounts];
  const date = findDate(mask(text, amounts), todayIso);
  if (date) claimed.push(date);
  const time = findTime(mask(text, claimed));
  if (time) claimed.push(time);
  const account = findAccount(text);
  if (account) claimed.push(account);

  const masked = mask(text, claimed);

  // Cash out of an ATM is not spending — it is money changing pocket, and
  // counting it as an expense overstates the month twice: once at the machine
  // and again when the cash is actually used. Flagged here, turned into a
  // transfer by the caller, which is the layer that knows about accounts.
  const cashWithdrawal = kind === 'expense' && /\batm\b|\bcash withdrawal\b|\bwithdraw(?:n|al)?\b/i.test(text);
  let merchant = findMerchant(masked, kind);
  if (cashWithdrawal) {
    merchant ??= 'ATM withdrawal';
  }

  if (date && date.iso > todayIso) {
    notes.push(`Date read as ${date.iso}, which is in the future — using today instead.`);
  }
  const occurredOn = date && date.iso <= todayIso ? date.iso : null;

  const issuer = detectIssuer(text);

  if (spendable.length > 1) {
    notes.push('More than one amount in this message — took the first.');
  }
  if (chosen.currency !== fallbackCurrency) {
    notes.push(`Amount is in ${chosen.currency}, not ${fallbackCurrency}. Nothing is converted.`);
  }

  let confidence = 0.35;
  if (issuer) confidence += 0.2;
  confidence += margin >= 3 ? 0.2 : margin >= 1 ? 0.1 : -0.1;
  if (occurredOn) confidence += 0.12;
  if (merchant) confidence += 0.12;
  if (account) confidence += 0.06;
  if (spendable.length > 1) confidence -= 0.12;
  // A foreign amount is never importable as-is — there is no rate here and a
  // finance app must not invent one. Push it firmly under the tick threshold.
  if (chosen.currency !== fallbackCurrency) confidence -= 0.3;

  const exponent = chosen.currency === 'JPY' || chosen.currency === 'KRW' ? 0 : 2;
  const amountMinor = Math.round(chosen.amount * 10 ** exponent + 1e-9);

  if (amountMinor <= 0) return { raw, reason: 'Amount is zero.' };

  return {
    raw,
    kind,
    amountMinor,
    currency: chosen.currency,
    merchant,
    occurredOn,
    occurredAtTime: time?.value ?? null,
    accountTail: account?.tail ?? null,
    issuer,
    cashWithdrawal,
    category: guessCategory(kind, merchant, text),
    confidence: clamp(Number(confidence.toFixed(2)), 0.05, 0.99),
    notes,
    fingerprint: fingerprint(raw),
  };
}

function isRejected(value: ParsedMessage | RejectedMessage): value is RejectedMessage {
  return 'reason' in value;
}

/** Parse a whole paste. The only entry point callers need. */
export function parsePaste(input: string, options: ParseOptions = {}): ParseReport {
  const parsed: ParsedMessage[] = [];
  const rejected: RejectedMessage[] = [];

  for (const message of splitMessages(input)) {
    const result = parseMessage(message, options);
    if (isRejected(result)) rejected.push(result);
    else parsed.push(result);
  }

  return { parsed, rejected };
}
