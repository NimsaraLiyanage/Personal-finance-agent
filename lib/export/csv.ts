// Writing CSV.
//
// Small enough to own rather than depend on, and the details that matter are
// specific to this app:
//
//   - **A UTF-8 BOM.** Without it Excel opens the file in the local ANSI
//     codepage and every Sinhala category name becomes mojibake. Nobody
//     believes a ledger that renders their own words as garbage.
//   - **Formulas are neutralised.** A description beginning `=`, `+`, `-` or
//     `@` is executed by Excel when the file is opened. A merchant name is
//     attacker-controlled text in an import, so it gets a leading apostrophe.
//   - **Amounts unformatted.** `2500.00`, not `Rs 2,500.00`: this file is for
//     a spreadsheet to add up, and a thousands separator inside a CSV cell is
//     how a column silently becomes text.

/** Excel executes cells starting with these. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function escapeCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';

  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;

  // Quote when the value contains anything that would otherwise break a row.
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: string[], rows: Array<Array<string | number | null>>): string {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  // CRLF: what every spreadsheet expects, and harmless everywhere else.
  return `﻿${lines.join('\r\n')}\r\n`;
}
