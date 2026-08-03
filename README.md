# Tally — a personal finance agent

A conversational finance assistant. Tell it what you spent, in text or out
loud, and it writes to your ledger, answers questions from your real data, and
renders the answer as a card rather than a wall of prose.

```
"coffee 4.50 and lunch 12.80"     → two transactions, one turn, one card each
"how much did I spend this month" → totals + category breakdown card
"keep dining under 200"           → a budget, with pace-adjusted progress
"show me the last 6 months"       → a chart
```

Built to demonstrate a specific thing: **one agent core serving both a text and
a voice surface**, with typed server-driven UI, without duplicating the tools,
memory, or business logic per surface.

---

## Why this exists

Most LLM demos are a chat box wrapping a completion call. The interesting
problems show up one layer down:

- How does the model **change state** safely, without the ability to name whose
  data it touches?
- How does a **voice** surface reuse the tools and memory a text surface
  already has, instead of becoming a second implementation that drifts?
- How does a conversation stay coherent at 200 messages without the prompt (and
  the bill) growing linearly?
- How does an LLM **drive a UI** without inventing markup?

Each of those has an answer in this repo, and each is a deliberate design, not
an accident of what the framework made easy.

---

## Architecture

```
                       ┌───────────────────────────────┐
  browser (text) ─────►│  POST /api/chat  (SSE)        │
                       │                               │
                       │   LangGraph ReAct loop        │
                       │   START → loadContext         │
                       │           → agent ⇄ tools     │
                       │           → END               │
  browser (voice)      │                               │
   ├─ pipeline ───────►│  (same route — see below)     │
   └─ realtime ──┐     └───────────────────────────────┘
                 │                    │
                 │                    ▼
                 │        10 Zod-typed tools → Postgres
                 │                    │
                 │                    ▼
                 └──►  PendingClientAction[]  ──► typed cards
```

### The agent loop — [`lib/agent/graph.ts`](lib/agent/graph.ts)

A three-node LangGraph state machine. `loadContext` assembles the turn's
prompt; `agent` calls the model with tools bound; `toolsCondition` routes to
`tools` and back whenever the model emits calls. That cycle is what lets *one*
message produce several tool calls plus a closing sentence that accounts for
all of them.

The agent node **streams** — prose deltas go out through `config.writer` while
the node still returns one complete message, so the same graph serves the SSE
route and a plain `invoke()` without a second code path.

### Server-driven UI — [`lib/agent/types.ts`](lib/agent/types.ts)

The model never emits UI. Tools push onto a discriminated union of directives:

```ts
type PendingClientAction =
  | { type: 'transaction_logged'; transaction: TransactionView; budgetTouched?: BudgetStatus }
  | { type: 'spending_summary';   summary: SpendingSummary }
  | { type: 'budget_status';      budgets: BudgetStatus[] }
  | { type: 'trend_chart';        title: string; points: TrendPoint[] }
  // …
```

The client switches on `type`, and the switch in
[`components/ActionCard.tsx`](components/ActionCard.tsx) is **exhaustive by
construction** — a `never` in the default branch means adding a variant without
handling it is a compile error, not a card that silently fails to render.

Two consequences worth naming: the model cannot invent a card shape the client
can't render, and the same action stream can drive a web client, a native
client, or a CLI without any of them re-parsing prose.

### Two voice modes behind one interface — [`lib/voice/`](lib/voice/)

`VoiceProvider` is the narrowest thing both transports fit through: *"give me
what the client needs to start talking."*

| | **pipeline** | **realtime** |
|---|---|---|
| Path | STT → text agent → TTS | duplex WebRTC to a speech-native model |
| Turn-taking | client-side RMS energy gate | server VAD, model-controlled |
| Latency | three round trips | one duplex stream |
| Cost | per token + per character | per audio minute |
| Tools | inherited from the text turn, free | relayed through `/api/voice/tool-call` |

The pipeline mode is the architecturally interesting one: it posts its
transcript to the *same* `/api/chat` endpoint the text box uses, so every tool,
card, and memory feature comes along at zero marginal cost. The realtime mode
buys much better turn-taking and pays for it per minute.

The UI exposes a toggle between them. In a product you'd pick one; here the
comparison is the point.

**Both modes hit the same failure if you tune them naively**: at a low VAD
threshold with a short silence window, the agent endpoints on a one-second
thinking pause, and residual speaker echo that survives the browser's AEC
retriggers it into answering *itself*. The defaults in
[`.env.example`](.env.example) are chosen against that failure, not for peak
speed — and the pipeline controller additionally hard-gates the mic while its
own audio is playing.

### Memory that doesn't grow without bound — [`lib/agent/summary.ts`](lib/agent/summary.ts)

Replaying the last N messages forgets that you're saving for a deposit.
Replaying everything grows the prompt forever. So: past a threshold, everything
older than the live window is compressed into durable notes and a checkpoint is
recorded. From then on the prompt is `summary + messages since checkpoint`,
roughly constant no matter how long the thread runs. It runs *after* the
response is sent — a slow summariser must never delay a reply.

### Money is never a float — [`lib/money.ts`](lib/money.ts)

Integer minor units everywhere past the API boundary. Decimals exist at exactly
two edges: what the model says (`"12.50"`) and what the user reads
(`"$12.50"`). Conversion rounds in decimal-string space, because
`Math.round(1.005 * 100)` is `100` — `1.005` is really `1.00499999999999989` in
binary.

### Calendars are local — [`lib/agent/time.ts`](lib/agent/time.ts)

Every question the agent gets is a calendar question: "this month", "yesterday",
"last week". Answering them in UTC puts a late-evening purchase in the wrong day
for anyone east of Greenwich, and the wrong month twice a year. Zero
dependencies — `Intl.DateTimeFormat` is the only timezone database in the
standard library, with a two-pass correction for DST boundaries.

---

## Security notes

Small app, but these are the ones that actually matter for an agent:

- **No tool takes a user id.** Every query is scoped by `runtime.userId`, which
  comes from the session cookie. A model that could name whose ledger it reads
  would be one prompt injection away from reading everyone's.
- **A thread id is not proof of ownership.** `resolveOwnedThread` is the only
  way a client-supplied id becomes usable, and a thread belonging to someone
  else is reported as *missing*, not *forbidden* — a 403 confirms it exists.
- **The API key never reaches a browser.** Realtime mode mints a short-lived,
  session-scoped client secret server-side; the pipeline legs proxy through our
  own routes.
- **`store: false` on every model call.** A finance ledger is personal data; the
  transcript lives in our Postgres and nowhere else.
- **The session cookie is HMAC-signed.** Unsigned, it's a raw user id anyone can
  edit in devtools to read someone else's ledger.

---

## Running it

Needs Node 20+, Docker (or any Postgres), and an OpenAI API key.

```bash
npm install
cp .env.example .env          # then fill in OPENAI_API_KEY + SESSION_SECRET

npm run db:up                 # Postgres 17 in Docker on :5434
npm run db:push               # apply the schema
npm run db:seed               # optional: 3 months of demo data

npm run dev                   # http://localhost:3000
```

Generate a session secret with `openssl rand -base64 32`.

> **Check `OPENAI_MODEL` before your first run.** Model identifiers change; a
> stale one fails at the first request with a 404. Everything else in
> `.env.example` has a working default.

Set `OPENAI_BASE_URL` to point the whole thing at any OpenAI-compatible
endpoint — Groq, Together, OpenRouter, a local Ollama or vLLM server. The text
agent has no other provider coupling.

---

## Project layout

```
lib/agent/
  graph.ts        LangGraph ReAct loop + turn persistence
  tools.ts        10 Zod-typed tools — the only way the model touches data
  types.ts        PendingClientAction union + SSE wire protocol
  stream.ts       SSE: interleaved tokens, tool starts, and actions
  context.ts      the account snapshot injected into every prompt
  summary.ts      rolling summarisation
  persistence.ts  threads + messages, ownership-scoped
  prompts.ts      shared base + per-surface overlay
  time.ts         timezone-correct calendar math
  model.ts        model factory (provider-swappable)

lib/voice/
  types.ts        VoiceProvider — the interface both modes satisfy
  realtime.ts     WebRTC session minting, VAD config, instruction assembly
  pipeline.ts     STT → text agent → TTS
  tools.ts        Zod → Realtime tool manifest, + relayed execution

lib/client/voice.ts   browser controllers for both modes

lib/finance/
  queries.ts      the read model — ONE implementation of every ledger question,
                  consumed by both the agent's tools and the dashboard
  periods.ts      the period vocabulary, shared with the client switcher
  months.ts       calendar-month windows for the monthly statement

components/           Chat, ActionCard (exhaustive), VoiceControl, SiteNav
components/dashboard/ StatTile, NetFlowChart, CategoryBreakdown, BudgetsPanel,
                      TransactionsPanel, AddTransaction, PeriodTabs
app/                  / (dashboard), /summary (monthly statement), /chat
app/actions/          Server Actions for manual entry, deletes, budgets
app/api/              chat (SSE), threads, voice/{session,tool-call,transcribe,speak}
```

### One read model, two surfaces

The dashboard does not re-implement "how much did I spend this month" — it calls
the same [`lib/finance/queries.ts`](lib/finance/queries.ts) the agent's tools
call. Two implementations of month boundaries drift the first time one of them
forgets timezones, and then the app argues with itself in front of the user.

---

## Deliberately not built

Scope discipline is part of the design:

- **No auth stack.** An HMAC-signed anonymous cookie stands in.
  [`lib/session.ts`](lib/session.ts) is the only module that knows how a request
  maps to a user, so swapping in Clerk or Auth.js is a one-file change.
- **No bank sync.** Manual and conversational entry only — an aggregator
  integration would be the bulk of the code and none of the interesting part.
- **One dashboard, not four screens.** Transactions, budgets and the trend all
  live on `/`; `navigate_to` resolves every screen it can name to that route
  rather than fanning out into separate views that each need their own state.
- **No financial advice.** The agent explains your own spending. It does not
  recommend investments or interpret tax law, and says so when asked.
