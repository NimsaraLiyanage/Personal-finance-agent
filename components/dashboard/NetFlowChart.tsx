'use client';

import { useState } from 'react';

import type { FlowPoint } from '@/lib/finance/queries';

// Net flow — income minus spending — per bucket.
//
// The job is polarity, not magnitude: the question a person actually has is
// "did I end this month up or down", and that is a sign, not a size. So this is
// a diverging column chart around a zero baseline rather than two series of
// bars the reader has to subtract by eye.

const PLOT_HEIGHT = 176;
/** Never let one side collapse to nothing when the other dwarfs it. */
const MIN_SHARE = 0.18;

export default function NetFlowChart({ points, title }: { points: FlowPoint[]; title: string }) {
  const [hover, setHover] = useState<number | null>(null);

  const posMax = Math.max(0, ...points.map((p) => p.netMinor));
  const negMax = Math.max(0, ...points.map((p) => -p.netMinor));
  // Keyed on activity, not on the net: a month where income exactly matched
  // spending has plenty to plot, it just nets to zero.
  const anyActivity = points.some((p) => p.incomeMinor > 0 || p.expenseMinor > 0);

  if (points.length === 0 || !anyActivity) {
    return (
      <Frame title={title}>
        <p className="py-10 text-center text-sm text-ink-faint">
          Nothing to plot yet — log some income and spending and this fills in.
        </p>
      </Frame>
    );
  }

  // Split the plot between the two halves in proportion to what each side has
  // to show, so an all-positive chart uses the whole height.
  // Everything netting to zero leaves nothing to divide by; centre the baseline
  // and let the break-even markers sit on it.
  let topShare = posMax + negMax === 0 ? 0.5 : posMax / (posMax + negMax);
  if (posMax > 0 && negMax > 0) topShare = Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, topShare));
  const topHeight = Math.round(PLOT_HEIGHT * topShare);
  const bottomHeight = PLOT_HEIGHT - topHeight;

  const scale = (value: number, axis: number, room: number) =>
    axis === 0 || room === 0 ? 0 : Math.max(2, Math.round((value / axis) * room));

  return (
    <Frame title={title}>
      <div className="relative" style={{ height: PLOT_HEIGHT }}>
        <div className="flex h-full items-stretch gap-0.5">
          {points.map((point, i) => {
            // A month with nothing in it is not a month you broke even in.
            // Without this the 2px minimum below — which exists so a tiny real
            // amount still shows — draws an empty month as a small positive
            // bar, which is the chart stating something the data never said.
            const active = point.incomeMinor > 0 || point.expenseMinor > 0;
            const positive = point.netMinor >= 0;
            const height = !active
              ? 0
              : point.netMinor === 0
                ? 2 // Broke even: a marker on the line, not a bar off it.
                : positive
                  ? scale(point.netMinor, posMax, topHeight)
                  : scale(-point.netMinor, negMax, bottomHeight);

            return (
              <div
                key={`${point.label}-${i}`}
                className="group relative flex flex-1 flex-col"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((current) => (current === i ? null : current))}
                onFocus={() => setHover(i)}
                onBlur={() => setHover((current) => (current === i ? null : current))}
                tabIndex={0}
                aria-label={
                  active
                    ? `${point.label}: in ${point.formattedIncome}, out ${point.formattedExpense}, net ${point.formattedNet}`
                    : `${point.label}: no transactions`
                }
              >
                <div className="flex items-end justify-center" style={{ height: topHeight }}>
                  {active && positive && (
                    <span
                      className={`w-full max-w-6 rounded-t transition-opacity group-hover:opacity-80 ${
                        // Broke even *with* activity is its own outcome, and a
                        // green sliver would overstate it.
                        point.netMinor === 0 ? 'bg-line-strong' : 'bg-accent'
                      }`}
                      style={{ height }}
                    />
                  )}
                </div>
                <div className="flex items-start justify-center" style={{ height: bottomHeight }}>
                  {active && !positive && (
                    <span
                      className="w-full max-w-6 rounded-b bg-danger transition-opacity group-hover:opacity-80"
                      style={{ height }}
                    />
                  )}
                </div>

                {hover === i && (
                  <Tooltip point={point} active={active} index={i} count={points.length} />
                )}
              </div>
            );
          })}
        </div>

        {/* Zero baseline: hairline, solid, recessive — the reference every
            column is read against. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 h-px bg-line-strong"
          style={{ top: topHeight }}
        />
      </div>

      <div className="mt-2 flex gap-0.5">
        {points.map((point, i) => (
          <span
            key={`${point.label}-label-${i}`}
            className="flex-1 truncate text-center text-[10px] text-ink-faint"
          >
            {point.label}
          </span>
        ))}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        Above the line you earned more than you spent; below it you spent more than came in.
      </p>

      <DataTable points={points} />
    </Frame>
  );
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="mb-4 text-xs font-medium uppercase tracking-wide text-ink-faint">{title}</h2>
      {children}
    </section>
  );
}

function Tooltip({
  point,
  active,
  index,
  count,
}: {
  point: FlowPoint;
  active: boolean;
  index: number;
  count: number;
}) {
  // Nudge the end columns inward so the panel never hangs off the card.
  const align =
    index === 0
      ? 'left-0'
      : index === count - 1
        ? 'right-0'
        : 'left-1/2 -translate-x-1/2';

  return (
    <div
      role="tooltip"
      className={`pointer-events-none absolute top-0 z-20 w-40 rounded-lg border border-line bg-surface p-2.5 text-left shadow-card ${align}`}
    >
      <div className="text-xs font-semibold text-ink">{point.label}</div>
      {active ? (
        <dl className="mt-1.5 space-y-1 text-[11px]">
          <Row term="In" value={point.formattedIncome} />
          <Row term="Out" value={point.formattedExpense} />
          <Row term="Net" value={point.formattedNet} strong />
        </dl>
      ) : (
        <p className="mt-1 text-[11px] text-ink-faint">No transactions</p>
      )}
    </div>
  );
}

function Row({ term, value, strong }: { term: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-faint">{term}</dt>
      <dd className={`tnum ${strong ? 'font-semibold text-ink' : 'text-ink-dim'}`}>{value}</dd>
    </div>
  );
}

// The numbers behind the marks, for anyone the chart doesn't work for —
// screen readers, colour-vision deficiency, or just wanting the exact figure.
function DataTable({ points }: { points: FlowPoint[] }) {
  return (
    <details className="mt-3 border-t border-line pt-3">
      <summary className="cursor-pointer text-[11px] text-ink-faint hover:text-ink-dim">
        Show the numbers
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-[11px] tnum">
          <thead className="text-ink-faint">
            <tr>
              <th className="py-1 pr-3 font-medium">Period</th>
              <th className="py-1 pr-3 text-right font-medium">In</th>
              <th className="py-1 pr-3 text-right font-medium">Out</th>
              <th className="py-1 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody className="text-ink-dim">
            {points.map((p, i) => (
              <tr key={`${p.label}-row-${i}`} className="border-t border-line">
                <td className="py-1 pr-3">{p.label}</td>
                <td className="py-1 pr-3 text-right">{p.formattedIncome}</td>
                <td className="py-1 pr-3 text-right">{p.formattedExpense}</td>
                <td className="py-1 text-right font-medium text-ink">{p.formattedNet}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
