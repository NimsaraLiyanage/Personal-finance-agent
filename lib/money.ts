// Money handling. One rule: minor units (cents) as integers, everywhere past
// the API boundary. Decimals exist only at the two edges — what the model
// says ("12.50") and what the user reads ("$12.50").

/** Currencies whose smallest unit IS the major unit (no cents). */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF']);

export function minorUnitExponent(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/**
 * Decimal major units → integer minor units.
 *
 * Rounds half-away-from-zero on the string form rather than multiplying the
 * float directly: `Math.round(1.005 * 100)` is 100, not 101, because 1.005 is
 * actually 1.00499999999999989 in binary. Doing it in decimal-string space
 * avoids inheriting that error.
 */
export function toMinor(amount: number, currency: string): number {
  if (!Number.isFinite(amount)) throw new Error(`Invalid amount: ${amount}`);
  const exp = minorUnitExponent(currency);
  const scaled = amount * 10 ** exp;
  // Nudge by an epsilon proportional to the magnitude to correct binary
  // representation error before truncating.
  const corrected = scaled + Math.sign(scaled) * 1e-9;
  return Math.round(corrected);
}

/** Integer minor units → decimal major units. */
export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** minorUnitExponent(currency);
}

/** Human-readable, locale-aware. Used in tool results and UI cards. */
export function formatMoney(minor: number, currency: string, locale = 'en-US'): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
      // narrowSymbol so LKR reads "Rs 1,234.50" rather than "LKR 1,234.50" —
      // and USD stays "$", EUR stays "€". The default 'symbol' display falls
      // back to the ISO code for most non-Western currencies, which is how a
      // rupee ends up shouting its own currency code in every table cell.
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: minorUnitExponent(currency),
    }).format(toMajor(minor, currency));
  } catch {
    // Unknown/invalid ISO code — never throw inside a tool result.
    return `${currency} ${toMajor(minor, currency).toFixed(minorUnitExponent(currency))}`;
  }
}

export function sumMinor(values: Array<{ amountMinor: number }>): number {
  return values.reduce((acc, v) => acc + v.amountMinor, 0);
}
