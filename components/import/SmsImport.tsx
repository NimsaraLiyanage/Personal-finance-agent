'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { findAlreadyImported, importMessages, type ImportOutcome } from '@/app/actions/import';
import type { CategoryOption } from '@/lib/finance/categories';
import { LOW_CONFIDENCE, parsePaste, type ParsedMessage } from '@/lib/import/sms';
import { formatMoney } from '@/lib/money';

// Paste-and-review.
//
// The parser is pure and runs in the browser, so the table below updates as you
// type with no round trip — which is the whole reason this feels like a tool
// rather than a form. The server re-parses the same raw text before writing, so
// what you see is a preview of the server's own reading, not a separate one.
//
// Nothing is imported until the button is pressed. Anything the parser is
// unsure about arrives unticked, because the failure mode of a silent bad
// import is a ledger you stop believing.

const EXAMPLE = `Your Card No.4512XXXXXXXX7890 was used for a purchase of LKR 2,500.00 at KEELLS SUPER on 03/08/2026 14:23. Avl Bal LKR 45,300.00
Sampath Bank: A/C XXXX5678 debited LKR 3,000.00 on 03/08/26 for FUND TRANSFER. Bal LKR 12,400.00
FriMi: You paid LKR 1,200.00 to PIZZA HUT KOTTAWA`;

export default function SmsImport({
  currency,
  today,
  categories,
}: {
  currency: string;
  today: string;
  categories: CategoryOption[];
}) {
  const [text, setText] = useState('');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [imported, setImported] = useState<Set<string>>(new Set());
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  const report = useMemo(() => parsePaste(text, { currency, today }), [text, currency, today]);

  // Ask the server which of these it has seen before. Debounced, and guarded
  // by a token so a slow reply for old text can't overwrite a fresh one.
  const token = useRef(0);
  const fingerprints = report.parsed.map((m) => m.fingerprint).join(',');
  useEffect(() => {
    if (!fingerprints) {
      setImported(new Set());
      return;
    }
    const mine = ++token.current;
    const timer = setTimeout(() => {
      findAlreadyImported(fingerprints.split(','))
        .then((known) => {
          if (token.current === mine) setImported(new Set(known));
        })
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [fingerprints]);

  const isChecked = (message: ParsedMessage) => {
    if (excluded.has(message.fingerprint)) return false;
    if (imported.has(message.fingerprint)) return false;
    return message.confidence >= LOW_CONFIDENCE && message.currency === currency;
  };

  const toggle = (fingerprint: string, next: boolean) => {
    setExcluded((current) => {
      const copy = new Set(current);
      if (next) copy.delete(fingerprint);
      else copy.add(fingerprint);
      return copy;
    });
    // Re-ticking something already in the ledger is a deliberate act: honour it.
    if (next) {
      setImported((current) => {
        if (!current.has(fingerprint)) return current;
        const copy = new Set(current);
        copy.delete(fingerprint);
        return copy;
      });
    }
  };

  const selected = report.parsed.filter(isChecked);

  const submit = () => {
    setOutcome(null);
    startTransition(async () => {
      const result = await importMessages(
        selected.map((message) => ({
          raw: message.raw,
          category: overrides[message.fingerprint] ?? message.category,
        })),
      );
      setOutcome(result);
      if (result.ok && result.imported > 0) setText('');
    });
  };

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
            Paste your bank messages
          </h2>
          {text.length === 0 && (
            <button
              type="button"
              onClick={() => setText(EXAMPLE)}
              className="text-xs text-accent hover:underline"
            >
              Try it with an example
            </button>
          )}
        </div>

        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={7}
          spellCheck={false}
          aria-label="Bank SMS messages"
          placeholder={`One message per line, or a blank line between them.\n\n${EXAMPLE.split('\n')[0]}`}
          className="scroll-quiet w-full resize-y rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-xs leading-relaxed outline-none transition-colors placeholder:text-ink-faint/70 focus:border-accent-dim"
        />

        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Nothing leaves your browser until you press import — the reading below is
          worked out here, on this page. Dates are read day-first, so 03/08 is 3 August.
        </p>
      </section>

      {outcome && <Outcome outcome={outcome} />}

      {report.parsed.length > 0 && (
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
              Review · {report.parsed.length} found
            </h2>
            <span className="text-xs text-ink-faint">
              {selected.length} ticked
              {imported.size > 0 && ` · ${imported.size} already imported`}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <caption className="sr-only">
                Messages read from your paste. Untick anything you do not want, and change a
                category before importing.
              </caption>
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th scope="col" className="w-10 px-3 py-2.5 font-medium">
                    <span className="sr-only">Import</span>
                  </th>
                  <th scope="col" className="w-24 px-3 py-2.5 font-medium">Date</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Description</th>
                  <th scope="col" className="w-40 px-3 py-2.5 font-medium">Category</th>
                  <th scope="col" className="w-32 px-3 py-2.5 text-right font-medium">Amount</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-line">
                {report.parsed.map((message) => (
                  <Row
                    key={message.fingerprint}
                    message={message}
                    currency={currency}
                    categories={categories}
                    checked={isChecked(message)}
                    alreadyImported={imported.has(message.fingerprint)}
                    category={overrides[message.fingerprint] ?? message.category}
                    onToggle={(next) => toggle(message.fingerprint, next)}
                    onCategory={(value) =>
                      setOverrides((current) => ({ ...current, [message.fingerprint]: value }))
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line px-4 py-3">
            <button
              type="button"
              onClick={submit}
              disabled={pending || selected.length === 0}
              className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:bg-line-strong disabled:text-ink-faint"
            >
              {pending
                ? 'Importing…'
                : selected.length === 0
                  ? 'Nothing ticked'
                  : `Import ${selected.length} ${selected.length === 1 ? 'entry' : 'entries'}`}
            </button>
          </div>
        </section>
      )}

      {report.rejected.length > 0 && (
        <details className="card p-4 text-sm">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-ink-faint">
            Skipped · {report.rejected.length}
          </summary>
          <ul className="mt-3 space-y-2.5">
            {report.rejected.map((item, index) => (
              <li key={index} className="border-l-2 border-line pl-3">
                <p className="text-xs text-ink-dim">{item.reason}</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">{item.raw}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Row({
  message,
  currency,
  categories,
  checked,
  alreadyImported,
  category,
  onToggle,
  onCategory,
}: {
  message: ParsedMessage;
  currency: string;
  categories: CategoryOption[];
  checked: boolean;
  alreadyImported: boolean;
  category: string;
  onToggle: (next: boolean) => void;
  onCategory: (value: string) => void;
}) {
  const income = message.kind === 'income';
  const foreign = message.currency !== currency;
  const unsure = message.confidence < LOW_CONFIDENCE;

  // The category the parser guessed may not be in the person's list yet — a
  // fresh account has the defaults, but a renamed one might not. Offer it
  // anyway rather than silently swapping their entry for something else.
  const options = categories.some((option) => option.slug === category)
    ? categories
    : [{ slug: category, label: category, builtIn: false }, ...categories];

  return (
    <tr className={checked ? '' : 'opacity-55'}>
      <td className="px-3 py-2.5 align-top">
        <input
          type="checkbox"
          checked={checked}
          disabled={foreign}
          onChange={(event) => onToggle(event.target.checked)}
          aria-label={`Import ${message.merchant ?? message.category}`}
          className="mt-0.5 size-4 accent-[var(--color-accent)] disabled:opacity-40"
        />
      </td>

      <td className="px-3 py-2.5 align-top text-xs tnum text-ink-dim">
        {message.occurredOn ?? 'today'}
        {message.occurredAtTime && (
          <span className="block text-ink-faint">{message.occurredAtTime}</span>
        )}
      </td>

      <td className="px-3 py-2.5 align-top">
        <div className="truncate font-medium">{message.merchant ?? 'Unnamed'}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
          {message.issuer && <Chip>{message.issuer.label}</Chip>}
          {message.accountTail && <Chip>••{message.accountTail}</Chip>}
          {alreadyImported && <Chip tone="muted">Already imported</Chip>}
          {unsure && !foreign && <Chip tone="warn">Check this one</Chip>}
          {foreign && <Chip tone="warn">{message.currency} — add by hand</Chip>}
        </div>
        {message.notes.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {message.notes.map((note, index) => (
              <li key={index} className="text-[11px] leading-snug text-ink-faint">
                {note}
              </li>
            ))}
          </ul>
        )}
      </td>

      <td className="px-3 py-2.5 align-top">
        <select
          value={category}
          onChange={(event) => onCategory(event.target.value)}
          aria-label="Category"
          className="w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-xs outline-none transition-colors focus:border-accent-dim"
        >
          {options.map((option) => (
            <option key={option.slug} value={option.slug}>
              {option.label}
            </option>
          ))}
        </select>
      </td>

      <td
        className={`px-3 py-2.5 text-right align-top tnum ${income ? 'text-accent' : 'text-ink'}`}
      >
        {income ? '+' : '−'}
        {formatMoney(message.amountMinor, message.currency)}
      </td>
    </tr>
  );
}

function Chip({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'warn' | 'muted';
}) {
  const style =
    tone === 'warn'
      ? 'border-warn/40 bg-warn/10 text-warn'
      : tone === 'muted'
        ? 'border-line bg-surface-2 text-ink-faint'
        : 'border-line bg-surface-2 text-ink-dim';
  return (
    <span className={`rounded-full border px-1.5 py-px ${style}`}>{children}</span>
  );
}

function Outcome({ outcome }: { outcome: ImportOutcome }) {
  if (!outcome.ok && outcome.error) {
    return (
      <p role="alert" className="card px-4 py-3 text-sm text-danger">
        {outcome.error}
      </p>
    );
  }

  return (
    <section role="status" className="card space-y-2 px-4 py-3 text-sm">
      <p>
        <strong className="font-semibold text-accent">
          {outcome.imported} {outcome.imported === 1 ? 'entry' : 'entries'} imported
        </strong>
        {outcome.duplicates > 0 && (
          <span className="text-ink-dim">
            {' '}
            · {outcome.duplicates} were already in your ledger
          </span>
        )}
        {outcome.imported > 0 && (
          <>
            {' · '}
            <Link href="/summary" className="text-accent hover:underline">
              see the month
            </Link>
          </>
        )}
      </p>

      {outcome.rejected.length > 0 && (
        <ul className="space-y-1.5 border-t border-line pt-2">
          {outcome.rejected.map((item, index) => (
            <li key={index} className="text-xs text-ink-dim">
              {item.reason}
              <span className="block truncate font-mono text-[11px] text-ink-faint">{item.raw}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
