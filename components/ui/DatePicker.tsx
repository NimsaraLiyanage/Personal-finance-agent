'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

// A calendar that belongs to this app rather than to the operating system.
//
// `<input type="date">` is functional and free, but it renders whatever the OS
// feels like — a different typeface, a different accent, a different shape on
// every machine, sitting inside a form that is otherwise ours. This is the same
// affordance in the app's own design language.
//
// Dates here are plain `YYYY-MM-DD` calendar strings, never Date objects in
// state. The moment a picker starts doing timezone arithmetic it starts landing
// people on the previous day, and a calendar has no business knowing what an
// instant is.

interface Props {
  name: string;
  /** `YYYY-MM-DD`. */
  value: string;
  onChange?: (value: string) => void;
  /** Latest selectable day, `YYYY-MM-DD`. Defaults to `value` acting as today. */
  max?: string;
  className?: string;
}

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

// ── Calendar arithmetic on plain numbers ────────────────────────────────────
// Everything goes through Date.UTC so a DST boundary can never shift a day.

function toKey(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

function fromKey(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split('-').map(Number);
  return { year, month, day };
}

function shiftDays(key: string, delta: number): string {
  const { year, month, day } = fromKey(key);
  return toKey(year, month, day + delta);
}

function shiftMonths(key: string, delta: number): string {
  const { year, month, day } = fromKey(key);
  // Clamp the day so 31 Jan + 1 month is 28/29 Feb, not 2/3 March.
  const lastDay = new Date(Date.UTC(year, month + delta, 0)).getUTCDate();
  return toKey(year, month + delta, Math.min(day, lastDay));
}

/** 0 = Monday. The app treats weeks as Monday-first everywhere else too. */
function weekdayIndex(year: number, month: number, day: number): number {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function longLabel(key: string): string {
  const { year, month, day } = fromKey(key);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export default function DatePicker({ name, value, onChange, max, className = '' }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(value);
  const [view, setView] = useState(() => fromKey(value));
  const [focusKey, setFocusKey] = useState(value);

  const trigger = useRef<HTMLButtonElement>(null);
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());
  const gridId = useId();

  const today = max ?? value;
  const ceiling = max ?? null;

  const commit = useCallback(
    (key: string) => {
      setSelected(key);
      setView(fromKey(key));
      onChange?.(key);
      setOpen(false);
      trigger.current?.focus();
    },
    [onChange],
  );

  // Escape closes from anywhere inside the popover, including the header
  // buttons — not just while a day has focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Roving focus: the arrow keys move `focusKey`, and the day button that key
  // belongs to pulls the browser's focus to itself once it has rendered.
  useEffect(() => {
    if (!open) return;
    dayRefs.current.get(focusKey)?.focus();
  }, [open, focusKey, view.year, view.month]);

  const cells = useMemo(() => {
    const leading = weekdayIndex(view.year, view.month, 1);
    const daysThisMonth = new Date(Date.UTC(view.year, view.month, 0)).getUTCDate();
    const total = Math.ceil((leading + daysThisMonth) / 7) * 7;

    return Array.from({ length: total }, (_, i) => {
      const dayNumber = i - leading + 1;
      const key = toKey(view.year, view.month, dayNumber);
      return {
        key,
        day: fromKey(key).day,
        inMonth: dayNumber >= 1 && dayNumber <= daysThisMonth,
        disabled: ceiling !== null && key > ceiling,
      };
    });
  }, [view.year, view.month, ceiling]);

  const moveFocus = (next: string) => {
    if (ceiling !== null && next > ceiling) return;
    const parts = fromKey(next);
    if (parts.year !== view.year || parts.month !== view.month) {
      setView({ year: parts.year, month: parts.month, day: parts.day });
    }
    setFocusKey(next);
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };

    if (e.key in moves) {
      e.preventDefault();
      moveFocus(shiftDays(focusKey, moves[e.key]));
      return;
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      moveFocus(shiftMonths(focusKey, e.key === 'PageUp' ? -1 : 1));
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const { year, month, day } = fromKey(focusKey);
      const offset = weekdayIndex(year, month, day);
      moveFocus(shiftDays(focusKey, e.key === 'Home' ? -offset : 6 - offset));
    }
  };

  const openCalendar = () => {
    setView(fromKey(selected));
    setFocusKey(selected);
    setOpen(true);
  };

  return (
    <div className={`relative ${className}`}>
      <input type="hidden" name={name} value={selected} />

      <button
        ref={trigger}
        type="button"
        onClick={() => (open ? setOpen(false) : openCalendar())}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border bg-surface px-2.5 py-2 text-left text-sm transition-colors ${
          open ? 'border-accent-dim' : 'border-line hover:border-line-strong'
        }`}
      >
        <span className="truncate">{longLabel(selected)}</span>
        <CalendarGlyph />
      </button>

      {open && (
        <>
          {/* Click-away layer, under the panel and over everything else. */}
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />

          <div
            role="dialog"
            aria-label="Choose a date"
            className="absolute right-0 z-40 mt-1.5 w-[17.5rem] animate-rise rounded-xl border border-line bg-surface p-3 shadow-card"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <StepButton
                label="Previous month"
                onClick={() => setView(fromKey(shiftMonths(toKey(view.year, view.month, 1), -1)))}
              >
                ‹
              </StepButton>
              <span aria-live="polite" className="text-sm font-semibold tracking-tight">
                {monthLabel(view.year, view.month)}
              </span>
              <StepButton
                label="Next month"
                disabled={
                  ceiling !== null && toKey(view.year, view.month + 1, 1) > ceiling
                }
                onClick={() => setView(fromKey(shiftMonths(toKey(view.year, view.month, 1), 1)))}
              >
                ›
              </StepButton>
            </div>

            <div
              aria-hidden
              className="grid grid-cols-7 gap-0.5 text-center text-[10px] font-medium text-ink-faint"
            >
              {WEEKDAYS.map((d, i) => (
                <span key={`${d}-${i}`} className="py-1">
                  {d}
                </span>
              ))}
            </div>

            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
            <div
              id={gridId}
              role="grid"
              onKeyDown={onGridKeyDown}
              className="mt-0.5 grid grid-cols-7 gap-0.5"
            >
              {cells.map((cell) => {
                const isSelected = cell.key === selected;
                const isToday = cell.key === today;

                return (
                  <button
                    key={cell.key}
                    ref={(node) => {
                      if (node) dayRefs.current.set(cell.key, node);
                      else dayRefs.current.delete(cell.key);
                    }}
                    type="button"
                    role="gridcell"
                    aria-selected={isSelected}
                    aria-label={longLabel(cell.key)}
                    disabled={cell.disabled}
                    // Roving tabindex: one stop for the whole grid, then the
                    // arrow keys do the walking.
                    tabIndex={cell.key === focusKey ? 0 : -1}
                    onClick={() => commit(cell.key)}
                    className={dayClass(cell, isSelected, isToday)}
                  >
                    {cell.day}
                  </button>
                );
              })}
            </div>

            <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
              <span className="text-[11px] text-ink-faint">
                {selected === today ? 'Today' : longLabel(selected)}
              </span>
              <button
                type="button"
                onClick={() => commit(today)}
                className="rounded-lg px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent-soft"
              >
                Today
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function dayClass(
  cell: { inMonth: boolean; disabled: boolean },
  isSelected: boolean,
  isToday: boolean,
): string {
  const base =
    'relative grid h-8 place-items-center rounded-lg text-xs tabular-nums transition-colors';

  if (cell.disabled) return `${base} cursor-not-allowed text-ink-faint/35`;
  if (isSelected) return `${base} bg-accent font-semibold text-white`;
  if (isToday) return `${base} bg-accent-soft font-semibold text-accent hover:bg-accent-dim/40`;
  if (!cell.inMonth) return `${base} text-ink-faint/60 hover:bg-surface-2`;
  return `${base} text-ink-dim hover:bg-surface-2 hover:text-ink`;
}

function StepButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid size-7 place-items-center rounded-lg border border-line text-sm text-ink-dim transition-colors hover:border-accent-dim hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint/40 disabled:hover:border-line"
    >
      {children}
    </button>
  );
}

function CalendarGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-4 shrink-0 text-ink-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
    >
      <rect x="3.5" y="5.5" width="17" height="15" rx="3" />
      <path d="M3.5 10h17M8 3.5v4M16 3.5v4" />
    </svg>
  );
}
