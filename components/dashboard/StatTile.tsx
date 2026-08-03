// A headline number. Not a chart — a single current value with an optional
// change against the previous period is a stat tile, and a one-bar bar chart
// would say the same thing with ten times the ink.

export interface Delta {
  /** Signed fraction: 0.12 is up 12%. */
  pct: number;
  /** What it is being compared against, e.g. "last month". */
  comparedTo: string;
  /** Whether an increase is a good outcome for this measure. */
  upIsGood: boolean;
}

interface Props {
  label: string;
  value: string;
  sub?: string;
  delta?: Delta | null;
  /** Colours the value itself. Used for net, where the sign is the story. */
  tone?: 'neutral' | 'good' | 'bad';
}

export default function StatTile({ label, value, sub, delta, tone = 'neutral' }: Props) {
  const valueTone =
    tone === 'good' ? 'text-accent' : tone === 'bad' ? 'text-danger' : 'text-ink';

  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-ink-faint">{label}</div>
      {/* Proportional figures, not tabular: these are display-size standalone
          numbers, and tabular-nums makes them look gappy at this size. */}
      <div className={`mt-1.5 text-2xl font-semibold tracking-tight ${valueTone}`}>{value}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {delta && <DeltaBadge {...delta} />}
        {sub && <span className="text-ink-faint">{sub}</span>}
      </div>
    </div>
  );
}

function DeltaBadge({ pct, comparedTo, upIsGood }: Delta) {
  const up = pct >= 0;
  const good = up === upIsGood;
  const rounded = Math.abs(Math.round(pct * 100));

  // Zero movement is neither good nor bad, and colouring it either way reads
  // as a judgement the data doesn't support.
  if (rounded === 0) {
    return <span className="text-ink-faint">Flat vs {comparedTo}</span>;
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${
        good ? 'bg-accent-soft text-accent' : 'bg-danger/10 text-danger'
      }`}
    >
      {/* The arrow carries direction so the meaning survives without colour. */}
      <span aria-hidden>{up ? '▲' : '▼'}</span>
      {rounded}% vs {comparedTo}
    </span>
  );
}
