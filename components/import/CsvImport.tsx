'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { findImportedCsvRows, importCsv, type CsvImportOutcome } from '@/app/actions/csv';
import type { AccountOption } from '@/lib/finance/account-types';
import type { CategoryOption } from '@/lib/finance/categories';
import {
  applyMapping,
  guessMapping,
  parseCsv,
  validateMapping,
  type ColumnRole,
} from '@/lib/import/csv';
import { formatMoney } from '@/lib/money';

// Upload, map the columns, review, import.
//
// The mapping row is the actual feature. Every bank names its columns
// differently, so the guess is a courtesy and the dropdowns are the product —
// which is also why the guess never hides: you can see what it decided and
// change it before a single row is written.

const ROLE_LABELS: Array<{ value: ColumnRole; label: string }> = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'date', label: 'Date' },
  { value: 'description', label: 'Description' },
  { value: 'amount', label: 'Amount (signed)' },
  { value: 'debit', label: 'Money out' },
  { value: 'credit', label: 'Money in' },
  { value: 'balance', label: 'Balance' },
  { value: 'category', label: 'Category' },
  { value: 'reference', label: 'Reference' },
];

export default function CsvImport({
  currency,
  today,
  categories,
  accounts,
}: {
  currency: string;
  today: string;
  categories: CategoryOption[];
  accounts: AccountOption[];
}) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [roles, setRoles] = useState<ColumnRole[] | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [alreadyIn, setAlreadyIn] = useState<Set<string>>(new Set());
  const [accountId, setAccountId] = useState(
    () => accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? '',
  );
  const [outcome, setOutcome] = useState<CsvImportOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  const table = useMemo(() => (text ? parseCsv(text) : null), [text]);

  // Re-guess whenever a new file lands, but never stomp a manual change.
  useEffect(() => {
    if (table) setRoles(guessMapping(table.headers).roles);
    else setRoles(null);
  }, [table]);

  const mappingError = roles ? validateMapping({ roles }) : null;

  const report = useMemo(() => {
    if (!table || !roles || mappingError) return null;
    return applyMapping(table, { roles }, { currency, today });
  }, [table, roles, mappingError, currency, today]);

  // Ask the server which rows it has seen before. Debounced and token-guarded
  // so a slow reply for an old file can't overwrite a fresh one.
  const token = useRef(0);
  const fingerprints = report?.rows.map((r) => r.fingerprint).join(',') ?? '';
  useEffect(() => {
    if (!fingerprints) {
      setAlreadyIn(new Set());
      return;
    }
    const mine = ++token.current;
    const timer = setTimeout(() => {
      findImportedCsvRows(fingerprints.split(','))
        .then((known) => {
          if (token.current === mine) setAlreadyIn(new Set(known));
        })
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [fingerprints]);

  const readFile = async (file: File) => {
    setOutcome(null);
    setExcluded(new Set());
    setOverrides({});
    setFileName(file.name);
    setText(await file.text());
  };

  const isChecked = (fingerprint: string) =>
    !excluded.has(fingerprint) && !alreadyIn.has(fingerprint);

  const selected = report?.rows.filter((r) => isChecked(r.fingerprint)) ?? [];

  const submit = () => {
    if (!roles || !table) return;
    setOutcome(null);
    startTransition(async () => {
      const result = await importCsv({
        text,
        delimiter: table.delimiter,
        roles,
        selected: selected.map((r) => r.fingerprint),
        categories: overrides,
        accountId: accountId || undefined,
      });
      setOutcome(result);
      if (result.ok && result.imported > 0) {
        setText('');
        setFileName(null);
      }
    });
  };

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
          Upload a statement
        </h2>

        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-line-strong px-4 py-6 transition-colors hover:border-accent-dim">
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
          <span className="text-sm">
            <span className="font-medium text-accent">Choose a CSV file</span>
            <span className="text-ink-faint">
              {fileName ? ` — ${fileName}` : ' — exported from your bank'}
            </span>
          </span>
        </label>

        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          The file is read in your browser. Dates are day-first, so 03/08 is 3 August.
        </p>
      </section>

      {outcome && <Outcome outcome={outcome} />}

      {table && roles && (
        <section className="card p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
              What is in each column
            </h2>
            <span className="text-[11px] text-ink-faint">
              {table.rows.length} rows · separated by{' '}
              {table.delimiter === '\t' ? 'tabs' : `"${table.delimiter}"`}
            </span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {table.headers.map((header, index) => (
              <label key={`${header}-${index}`} className="block">
                <span className="mb-1 block truncate text-[11px] text-ink-faint" title={header}>
                  {header || `Column ${index + 1}`}
                </span>
                <select
                  value={roles[index] ?? 'ignore'}
                  onChange={(event) => {
                    const next = [...roles];
                    next[index] = event.target.value as ColumnRole;
                    setRoles(next);
                  }}
                  className="w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-xs outline-none transition-colors focus:border-accent-dim"
                >
                  {ROLE_LABELS.map((role) => (
                    <option key={role.value} value={role.value}>
                      {role.label}
                    </option>
                  ))}
                </select>
                {table.rows[0]?.[index] && (
                  <span className="mt-0.5 block truncate text-[11px] text-ink-faint/80">
                    e.g. {table.rows[0][index]}
                  </span>
                )}
              </label>
            ))}
          </div>

          {mappingError && (
            <p role="alert" className="mt-3 rounded-lg bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
              {mappingError}
            </p>
          )}

          {accounts.length > 1 && (
            <label className="mt-3 block max-w-xs">
              <span className="mb-1 block text-[11px] text-ink-faint">
                This statement is from
              </span>
              <select
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                className="w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm outline-none transition-colors focus:border-accent-dim"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>
      )}

      {report && report.rows.length > 0 && (
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
              Review · {report.rows.length} found
            </h2>
            <span className="text-xs text-ink-faint">
              {selected.length} ticked
              {alreadyIn.size > 0 && ` · ${alreadyIn.size} already imported`}
            </span>
          </div>

          <div className="max-h-[28rem] overflow-auto scroll-quiet">
            <table className="w-full min-w-[42rem] border-collapse text-sm">
              <caption className="sr-only">
                Rows read from the statement. Untick anything you do not want.
              </caption>
              <thead className="sticky top-0 bg-surface-2">
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
                {report.rows.map((row) => {
                  const checked = isChecked(row.fingerprint);
                  const category = overrides[row.fingerprint] ?? row.category ?? 'other';
                  const options = categories.some((c) => c.slug === category)
                    ? categories
                    : [{ slug: category, label: category, builtIn: false }, ...categories];

                  return (
                    <tr key={`${row.fingerprint}-${row.rowIndex}`} className={checked ? '' : 'opacity-55'}>
                      <td className="px-3 py-2 align-top">
                        <input
                          type="checkbox"
                          checked={checked}
                          aria-label={`Import ${row.description ?? 'row'}`}
                          onChange={(event) => {
                            setExcluded((current) => {
                              const copy = new Set(current);
                              if (event.target.checked) copy.delete(row.fingerprint);
                              else copy.add(row.fingerprint);
                              return copy;
                            });
                            if (event.target.checked) {
                              setAlreadyIn((current) => {
                                if (!current.has(row.fingerprint)) return current;
                                const copy = new Set(current);
                                copy.delete(row.fingerprint);
                                return copy;
                              });
                            }
                          }}
                          className="mt-0.5 size-4 accent-[var(--color-accent)]"
                        />
                      </td>
                      <td className="px-3 py-2 align-top text-xs tnum text-ink-dim">
                        {row.occurredOn ?? 'today'}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="truncate">{row.description ?? 'Unnamed'}</div>
                        {alreadyIn.has(row.fingerprint) && (
                          <span className="text-[11px] text-ink-faint">Already imported</span>
                        )}
                        {row.notes.map((note, i) => (
                          <span key={i} className="block text-[11px] leading-snug text-warn">
                            {note}
                          </span>
                        ))}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <select
                          value={category}
                          aria-label="Category"
                          onChange={(event) =>
                            setOverrides((current) => ({
                              ...current,
                              [row.fingerprint]: event.target.value,
                            }))
                          }
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
                        className={`px-3 py-2 text-right align-top tnum ${
                          row.kind === 'income' ? 'text-accent' : 'text-ink'
                        }`}
                      >
                        {row.kind === 'income' ? '+' : '−'}
                        {formatMoney(row.amountMinor, currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end border-t border-line px-4 py-3">
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
                  : `Import ${selected.length} ${selected.length === 1 ? 'row' : 'rows'}`}
            </button>
          </div>
        </section>
      )}

      {report && report.rejected.length > 0 && (
        <details className="card p-4 text-sm">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-ink-faint">
            Skipped · {report.rejected.length}
          </summary>
          <ul className="mt-3 space-y-2.5">
            {report.rejected.slice(0, 50).map((item) => (
              <li key={item.rowIndex} className="border-l-2 border-line pl-3">
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

function Outcome({ outcome }: { outcome: CsvImportOutcome }) {
  if (!outcome.ok && outcome.error) {
    return (
      <p role="alert" className="card px-4 py-3 text-sm text-danger">
        {outcome.error}
      </p>
    );
  }

  return (
    <p role="status" className="card px-4 py-3 text-sm">
      <strong className="font-semibold text-accent">
        {outcome.imported} {outcome.imported === 1 ? 'row' : 'rows'} imported
      </strong>
      {outcome.duplicates > 0 && (
        <span className="text-ink-dim"> · {outcome.duplicates} were already in your ledger</span>
      )}
      {outcome.skipped > 0 && (
        <span className="text-ink-dim"> · {outcome.skipped} unreadable</span>
      )}
    </p>
  );
}
