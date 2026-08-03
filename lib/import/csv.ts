// Bank statement CSV → ledger entries.
//
// The SMS importer had one hard problem: every bank writes a different
// sentence. This one has a different hard problem: every bank writes different
// COLUMNS, and there is no sentence to infer from. A statement might be
//
//   Date, Description, Debit, Credit, Balance
//   Transaction Date, Narration, Withdrawal (LKR), Deposit (LKR), Running Bal
//   Date, Details, Amount            ← one signed column instead of two
//
// So the shape is: guess the mapping from the headers, then let the person fix
// it. The guess is a convenience; the mapping is the feature. Everything after
// the mapping is shared with the SMS path — the same review table, the same
// per-row import key, the same server-side re-parse before anything is written.
//
// Pure, like ./sms.ts: no database, no `next/*`, no Node built-ins. The browser
// parses to draw the preview and the server re-parses to write from, and they
// are literally the same function.

import { parseDateCell } from './dates';

// ── Types ───────────────────────────────────────────────────────────────────

export type ColumnRole =
  | 'date'
  | 'description'
  /** One column carrying a sign: negative is money out. */
  | 'amount'
  /** Two columns: whichever is filled decides the direction. */
  | 'debit'
  | 'credit'
  | 'balance'
  | 'category'
  | 'reference'
  | 'ignore';

export interface ColumnMapping {
  /** Role for each column, by index. Length matches the header row. */
  roles: ColumnRole[];
}

export interface CsvTable {
  headers: string[];
  rows: string[][];
  /** What separated the fields. Reported so the UI can say if it guessed. */
  delimiter: string;
}

export interface CsvRowResult {
  /** The source line, rebuilt. The import key hashes this. */
  raw: string;
  rowIndex: number;
  kind: 'expense' | 'income';
  amountMinor: number;
  description: string | null;
  occurredOn: string | null;
  category: string | null;
  notes: string[];
  fingerprint: string;
}

export interface CsvRowRejection {
  raw: string;
  rowIndex: number;
  reason: string;
}

export interface CsvReport {
  rows: CsvRowResult[];
  rejected: CsvRowRejection[];
}

export interface CsvParseOptions {
  currency?: string;
  /** Today, as YYYY-MM-DD in the user's zone. Keeps this pure. */
  today?: string;
}

// ── Reading the file ────────────────────────────────────────────────────────

const DELIMITERS = [',', ';', '\t', '|'];

/**
 * Pick the separator by counting it on the first few lines.
 *
 * Comma is not safe to assume: exports from a machine set to a European locale
 * use semicolons, and plenty of banks emit tab-separated files with a `.csv`
 * extension. The winner is the character with the most CONSISTENT count per
 * line, not the highest count — commas inside descriptions would otherwise win
 * every time.
 */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 5);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = -1;

  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => splitLine(line, delimiter).length);
    const first = counts[0];
    if (first < 2) continue;
    const consistent = counts.every((count) => count === first);
    const score = (consistent ? 100 : 0) + first;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

/** One line, honouring quotes. Split out so delimiter detection can reuse it. */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else field += ch;
  }

  out.push(field);
  return out;
}

/**
 * Parse the whole file.
 *
 * Written by hand rather than pulled from a package because the awkward parts
 * are small and specific: a UTF-8 BOM that Excel adds and nothing strips, CRLF
 * endings, and newlines INSIDE a quoted description — which a line-by-line
 * split would tear in half and turn into two broken transactions.
 */
export function parseCsv(text: string, delimiter?: string): CsvTable {
  // Excel writes a BOM. Left in place it becomes part of the first header name,
  // so "Date" silently stops matching anything.
  const clean = text.replace(/^﻿/, '');
  const sep = delimiter ?? detectDelimiter(clean);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];

    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === sep) endField();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      // CRLF: the \n does the work. A lone \r also ends a row.
      if (clean[i + 1] !== '\n') endRow();
    } else field += ch;
  }

  if (field !== '' || row.length > 0) endRow();

  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows, delimiter: sep };
}

// ── Guessing the columns ────────────────────────────────────────────────────

const HEADER_HINTS: Array<{ role: ColumnRole; patterns: RegExp[] }> = [
  // Balance FIRST. "Running balance" contains neither "debit" nor "credit" but
  // "Closing Bal Amount" contains "amount" — and a balance read as an amount
  // turns a Rs 250 tea into a Rs 45,300 one, exactly as in the SMS parser.
  { role: 'balance', patterns: [/\bbal(?:ance)?\b/i, /\brunning\b/i, /\bclosing\b/i] },
  { role: 'date', patterns: [/\bdate\b/i, /\bday\b/i, /\bposted\b/i, /\bvalue dt\b/i] },
  { role: 'debit', patterns: [/\bdebit\b/i, /\bwithdraw(?:al|n)?\b/i, /\bpaid out\b/i, /\bmoney out\b/i, /\bdr\b/i] },
  { role: 'credit', patterns: [/\bcredit\b/i, /\bdeposit\b/i, /\bpaid in\b/i, /\bmoney in\b/i, /\bcr\b/i] },
  { role: 'amount', patterns: [/\bamount\b/i, /\bvalue\b/i, /\bsum\b/i] },
  { role: 'description', patterns: [/\bdescription\b/i, /\bnarration\b/i, /\bdetails?\b/i, /\bparticulars?\b/i, /\bmerchant\b/i, /\bpayee\b/i, /\bremarks?\b/i, /\bnote\b/i] },
  { role: 'category', patterns: [/\bcategory\b/i, /\btype\b/i] },
  { role: 'reference', patterns: [/\bref(?:erence)?\b/i, /\bcheque\b/i, /\btxn id\b/i] },
];

/**
 * A first pass at what each column is.
 *
 * Only ever a suggestion — the review screen shows every choice and lets it be
 * changed, because a wrong guess here is a whole statement filed backwards.
 */
export function guessMapping(headers: string[]): ColumnMapping {
  const roles: ColumnRole[] = headers.map((header) => {
    for (const { role, patterns } of HEADER_HINTS) {
      if (patterns.some((pattern) => pattern.test(header))) return role;
    }
    return 'ignore';
  });

  // Two roles that must be unique: keep the first, drop later duplicates.
  for (const unique of ['date', 'description', 'amount'] as const) {
    let seen = false;
    for (let i = 0; i < roles.length; i++) {
      if (roles[i] !== unique) continue;
      if (seen) roles[i] = 'ignore';
      seen = true;
    }
  }

  // A file with debit AND credit columns has no use for a signed amount column;
  // one without them needs it.
  const hasPair = roles.includes('debit') && roles.includes('credit');
  if (hasPair) {
    for (let i = 0; i < roles.length; i++) if (roles[i] === 'amount') roles[i] = 'ignore';
  }

  return { roles };
}

/** Is this mapping usable, and if not, what is missing? */
export function validateMapping(mapping: ColumnMapping): string | null {
  const roles = mapping.roles;
  if (!roles.includes('date')) return 'Pick which column holds the date.';

  const hasAmount = roles.includes('amount');
  const hasDebit = roles.includes('debit');
  const hasCredit = roles.includes('credit');

  if (!hasAmount && !hasDebit && !hasCredit) {
    return 'Pick the amount column — or a Money out and a Money in column.';
  }
  if (hasAmount && (hasDebit || hasCredit)) {
    return 'Use either one Amount column or the Money out / Money in pair, not both.';
  }
  return null;
}

// ── Numbers ─────────────────────────────────────────────────────────────────

/**
 * A statement cell to a signed number.
 *
 * Handles what these files really contain: thousands separators, currency
 * symbols glued to the figure, `1.234,56` written the European way, `(1,200)`
 * for a negative in accounting notation, and a trailing `DR`/`CR` marker.
 * Returns null for a blank or unreadable cell — never zero, because zero is a
 * real amount and "I could not read this" is not.
 */
export function parseAmountCell(value: string): number | null {
  let text = value.trim();
  if (!text) return null;

  let sign = 1;

  // Accounting negatives: (1,200.00)
  if (/^\(.*\)$/.test(text)) {
    sign = -1;
    text = text.slice(1, -1);
  }

  // Trailing DR/CR markers, used instead of a sign by several local banks.
  const marker = /\b(DR|CR)\b\.?$/i.exec(text);
  if (marker) {
    if (marker[1].toUpperCase() === 'DR') sign = -1;
    text = text.slice(0, marker.index);
  }

  if (text.trim().startsWith('-')) {
    sign = -1;
    text = text.trim().slice(1);
  } else if (text.trim().startsWith('+')) {
    text = text.trim().slice(1);
  }

  // Strip currency words and symbols, keep digits and separators.
  text = text.replace(/(?:LKR|Rs\.?|රු\.?|₨|USD|EUR|GBP|INR|\$|€|£)/gi, '').trim();
  text = text.replace(/\s/g, '');
  if (!text) return null;

  // Decide which separator is the decimal point. The LAST separator wins when
  // it is followed by exactly one or two digits; otherwise both are grouping.
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  const lastSep = Math.max(lastComma, lastDot);

  if (lastSep >= 0 && /^\d{1,2}$/.test(text.slice(lastSep + 1))) {
    const whole = text.slice(0, lastSep).replace(/[.,]/g, '');
    const fraction = text.slice(lastSep + 1);
    text = `${whole}.${fraction}`;
  } else {
    text = text.replace(/[.,]/g, '');
  }

  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? sign * amount : null;
}

// ── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * Stable identity for a statement row.
 *
 * Hashes the row as written, not our reading of it — the same reasoning as the
 * SMS importer. Re-uploading an overlapping statement is the normal way to use
 * this, and it must not double-count.
 */
export function fingerprintRow(cells: string[]): string {
  const normal = cells.map((c) => c.trim().toLowerCase()).join('');
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < normal.length; i++) {
    const c = normal.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ── Rows → entries ──────────────────────────────────────────────────────────

function cellAt(cells: string[], roles: ColumnRole[], role: ColumnRole): string {
  const index = roles.indexOf(role);
  return index >= 0 ? (cells[index] ?? '').trim() : '';
}

export function applyMapping(
  table: CsvTable,
  mapping: ColumnMapping,
  options: CsvParseOptions = {},
): CsvReport {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const exponent = 2;

  const rows: CsvRowResult[] = [];
  const rejected: CsvRowRejection[] = [];

  table.rows.forEach((cells, index) => {
    const raw = cells.join(table.delimiter);
    const reject = (reason: string) => rejected.push({ raw, rowIndex: index, reason });
    const notes: string[] = [];

    const occurredOn = parseDateCell(cellAt(cells, mapping.roles, 'date'), today);
    if (!occurredOn) {
      reject('Could not read the date in this row.');
      return;
    }
    if (occurredOn > today) {
      notes.push(`Dated ${occurredOn}, which is in the future — check it.`);
    }

    // Two shapes. The debit/credit pair is checked first because a file that
    // has both also often has an "amount" column holding the same figure
    // unsigned, and reading that one would lose the direction.
    let signed: number | null = null;

    if (mapping.roles.includes('debit') || mapping.roles.includes('credit')) {
      const debit = parseAmountCell(cellAt(cells, mapping.roles, 'debit'));
      const credit = parseAmountCell(cellAt(cells, mapping.roles, 'credit'));

      if (debit !== null && credit !== null && debit !== 0 && credit !== 0) {
        reject('Both Money out and Money in are filled — cannot tell which way this went.');
        return;
      }
      if (debit !== null && debit !== 0) signed = -Math.abs(debit);
      else if (credit !== null && credit !== 0) signed = Math.abs(credit);
    } else {
      signed = parseAmountCell(cellAt(cells, mapping.roles, 'amount'));
    }

    if (signed === null) {
      reject('No amount in this row.');
      return;
    }
    if (signed === 0) {
      reject('The amount is zero.');
      return;
    }

    const description = cellAt(cells, mapping.roles, 'description') || null;
    const reference = cellAt(cells, mapping.roles, 'reference');
    if (!description && reference) notes.push(`No description — reference ${reference}.`);

    rows.push({
      raw,
      rowIndex: index,
      kind: signed < 0 ? 'expense' : 'income',
      amountMinor: Math.round(Math.abs(signed) * 10 ** exponent + 1e-9),
      description: description ? description.replace(/\s+/g, ' ').slice(0, 80) : null,
      occurredOn: occurredOn > today ? null : occurredOn,
      category: cellAt(cells, mapping.roles, 'category') || null,
      notes,
      fingerprint: fingerprintRow(cells),
    });
  });

  return { rows, rejected };
}
