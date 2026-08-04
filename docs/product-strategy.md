# Tally — product strategy

**Written 3 August 2026.** Everything in the "landscape" section is a snapshot of
the market on that date and will decay; the retention research and the
architectural conclusions age much more slowly. Re-check the app list before
acting on it a year from now.

Context: Tally currently ships a web app (dashboard, monthly statement,
conversational + voice assistant). A mobile version is planned. This document
exists to answer one question — **why would someone use this instead of the
dozens of money apps already on the Play Store** — and to stop us building the
wrong things on the way there.

---

## 1. The uncomfortable part: our core idea is not unique

### Voice / natural-language logging is a commodity

A wave of apps shipped exactly this in 2025–26, all with the same marketing
line ("just say *spent $45 on dinner*"):

| App | What it does |
|---|---|
| **Dora AI** | Log by voice **and** ask questions of your data — the closest thing to Tally that exists |
| **ExpenseMind** | Voice → amount + merchant + category extraction, receipt parsing |
| **Voicash** | "Just say 'Spent $45 on dinner'" |
| **SpendVoice** | Voice-first logging, no forms |
| **WalletGPT** | "Coffee $4.50" → categorised automatically |
| **TalkieMoney** | Speech/text commands via NLP |
| **Expense tracker: Budget AI** | Splits multi-item utterances ("lunch $15 and cinema $8") |

Dora AI in particular has both halves of Tally's model — conversational entry
*and* conversational query. We are not first.

### In Sri Lanka, automatic capture is also already solved

Three local apps read bank SMS and log transactions with no typing:

| App | Notes |
|---|---|
| **Kiwi Money** | "Sri Lanka's First Automated Money Manager". ComBank, HNB, Sampath, NTB, Seylan + more |
| **Money Master** | 30+ banks, 100% on-device, free forever, no ads |
| **SpendSense LK** | Locally encrypted, "SpendSense cannot see your data" |

So SMS auto-capture is **table stakes for the Sri Lankan market**, not a moat.
Shipping it earns us parity, not preference.

### And the basics are long since commoditised

Monefy (fast entry, custom categories), Wallet by BudgetBakers (4,000+ bank
integrations, cloud sync), Spendee (shared wallets, bank/e-wallet/crypto sync),
Money Manager (receipt photos in the entry flow). Charts, budgets and category
breakdowns are the price of entry.

**Conclusion: we cannot win on "log your spending by voice." That race is over.**

---

## 2. The opportunity: all of these apps are failing

The category has a retention crisis, and it is well documented.

| Metric | Value |
|---|---|
| Time to abandonment | **3–4 weeks** after download |
| Day-30 retention, personal finance apps | **38%** |
| Top-10 finance apps, DAU lost D1 → D30 | **71%** |
| Users rating budgeting apps "not helpful" / "too much effort" | **67%** |
| Churn of manual-entry apps vs. auto-sync apps | **3× higher** |

The four reasons users quit:

1. It becomes **a chore** once setup is done.
2. Transactions **miscategorise** and need manual cleanup.
3. It shows **what happened, not what to do next**.
4. **Categories never match how the user actually thinks** about spending.

> "Budgeting app abandonment is not a user discipline problem, it is a product
> design problem."

**Three of those four are agent-shaped problems.** A chart cannot fix any of
them. An SMS parser cannot fix any of them. That is our opening — not the voice
input, but what happens after the data is in.

---

## 3. Where Tally can actually win

### A. Stop reporting. Start advising. ⭐ the big one

Today Tally speaks **only when spoken to**. That is reactive, and reactive is
exactly what the research says fails: competitors "provide alerts but limited
holistic guidance," while the thing that moves retention is AI that "catches
things humans miss — subscriptions you forgot about, merchants charging more
than usual, spending patterns that undermine your goals."

Build:

- **A weekly / monthly briefing the agent writes** — three paragraphs, not a
  chart. *"Transport went from Rs 4,000 to Rs 12,000 this month. Rideshare 14
  times, up from 3. At this pace you cross the dining budget around the 25th."*
- **Anomaly detection** — a merchant you normally pay Rs 1,200 charged Rs 3,000.
- **Forgotten subscriptions** — same amount, same day, three months running.
- **Cash-flow forecast** — "at this pace you finish the month Rs 8,400 short."

The seed already exists in the codebase: [`schedule_reminder`](../lib/agent/tools.ts)
is a tool the agent can already call. What is missing is the scheduler that runs
it, the prompt that writes the briefing, and somewhere to render it. On mobile,
**the push notification is the briefing** — and that is the retention lever.

### B. Categories are currently a weakness, not a strength

[`lib/agent/types.ts`](../lib/agent/types.ts) hardcodes 13 categories. That is
failure-reason #4, shipped.

- Let users **define their own categories**.
- Let the agent **learn their vocabulary** — "කඩේ" → groceries, "බස් එක" →
  transport, "අම්මට" → family.
- **Remember corrections permanently.** When someone says "no, that's transport,
  not other," that must stick forever. There is a rolling thread summary today
  ([`lib/agent/summary.ts`](../lib/agent/summary.ts)) but **no user-level
  preference memory**. Adding it kills failure-reason #2 outright.

### C. Capture *and* intelligence — nobody in Sri Lanka has both

| | Auto-capture | Intelligence |
|---|---|---|
| Kiwi Money, Money Master, SpendSense LK | ✅ | ❌ |
| Dora AI, ExpenseMind, Voicash, WalletGPT | ❌ | ✅ |
| **Tally (mobile)** | ✅ | ✅ |

The local apps file transactions and say nothing about them. The global AI apps
converse but cannot read a Commercial Bank SMS and are not targeting this market.

So the mobile SMS/notification listener is essential — but it is **an input to
the agent**, not the product. SMS arrives ("Rs 2,340 at KEELLS SUPER") → agent
categorises → agent says "groceries budget is 78% gone with 9 days left."

### D. Sinhala and Singlish

No global AI app understands "බස් එකට 100", "කඩේට ගිහින් 450", or code-switched
Sinhala/English in one sentence. For an LLM this is nearly free — a handful of
examples in the prompt — but for a Sri Lankan user it is the difference between
"an app" and "an app built for me." Extends to voice input.

---

## 4. What NOT to build

Scope discipline is what makes a solo build survivable.

- ❌ **Bank API integrations.** Wallet has 4,000+ banks. Sri Lanka has no open
  banking. Unwinnable, and SMS gets us most of the value.
- ❌ **Investments / crypto tracking.** A different product.
- ❌ **Receipt OCR.** Not early — SMS already carries the same data.
- ❌ **Subscription pricing out of the gate.** Competitor reviews are dominated
  by anger about unexpected renewals, denied refunds and cancellation friction.
  Money Master is already "free forever, no ads" — we cannot undercut that.
  Free core, local (LKR) pricing on the agent features, no dark patterns.

---

## 5. Codebase gaps to close before mobile

These are missing today and each one blocks something above:

| Gap | Why it matters |
|---|---|
| ~~**No accounts / wallets**~~ | Done. `Account` + per-account balances, and transfers as a linked pair excluded from every spending figure. SMS import routes by the masked card tail, and an ATM withdrawal is now a move to cash rather than a phantom expense. |
| ~~**No recurring / subscription model**~~ | Done. `Recurring` with cadence detection, a monthly commitment total, and — the part a query could never give — price changes and charges that stopped arriving. |
| **No user-level agent memory** | Thread summaries exist; durable corrections and preferences do not. |
| ~~**Fixed category enum**~~ | Done. `Category` + `CategoryRule`, user-owned, with learned corrections. |
| **Multi-currency is half-built** | Each transaction stores a currency, but nothing converts. Matters for anyone earning USD in LK. The SMS importer now *detects* a foreign amount and refuses to guess a rate, which is honest but not a feature. |
| ~~**No privacy story**~~ | Half done, and in the right half. `lib/import/sms.ts` is a pure function with no network and no model call: bank messages are read in the browser and only the resulting entries are written. The claim "your bank SMS is never sent to an AI" is now literally true. |

---

## 6. Suggested sequence

1. **Proactive weekly briefing** — prototype on web first. It is the retention
   lever and needs no mobile app to validate. Roughly: an `Insight` model, a
   briefing prompt, a scheduled job, and a card at the top of the dashboard.
2. **Custom categories + correction memory** — kills the miscategorisation
   complaint and is a prerequisite for the agent feeling personal.
3. **Sinhala / Singlish handling** — cheap, high perceived value locally.
4. **Mobile: SMS/notification listener** feeding the same agent, plus a quick-add
   widget, offline-first sync, and push notifications carrying the briefing.

   *Push already ships on the web.* The PWA is installable and the weekly
   briefing arrives as a notification with the app closed — so the retention
   loop can be tested before a line of native code exists.

   *Partly done already.* The understanding half shipped on web first, at
   `/import`: paste the messages, review, save. `lib/import/sms.ts` is
   dependency-free — no database, no `next/*`, no `node:crypto` — so the phone
   build reuses the file as-is and only supplies a different input pipe. The
   remaining mobile work is the Android permission and the listener, which is
   the part that could never have been validated from a laptop anyway.
5. ~~**Accounts/wallets**~~ — done, right after import rather than before it,
   which turned out to be the better order: the importer had already surfaced
   exactly what accounts needed to support (a masked card tail to route on, and
   ATM withdrawals that must not read as spending).

---

## In one sentence

> We cannot win on voice logging — that is a commodity. We win on **knowing your
> money better than you do and saying so before you ask.** In Sri Lanka that also
> requires SMS capture and understanding Sinhala. Nobody is doing all three.

---

## Sources

Market snapshot, August 2026:

- [Why 67% of People Who Try Budgeting Apps Quit Within 30 Days — Strategia-X](https://www.strategia-x.com/blog/2026-04-12-why-budgeting-apps-fail-30-days-fintech-ux-data/)
- [Why Personal Finance Apps Fail User Retention — Financial Fitness Passport](https://www.financialfitnesspassport.com/why-personal-finance-apps-fail-user-retention)
- [How Great Budget App Design Increases User Retention — Onething Design](https://www.onething.design/post/budget-app-design)
- [Kiwi Money — Sri Lanka's First Automated Money Manager](https://www.kiwi-money.com/)
- [Money Master — Automated Money Manager Sri Lanka](https://moneymasterapp.com/)
- [SpendSense LK — Google Play](https://play.google.com/store/apps/details?id=com.spendsense.app&hl=en_US)
- [Dora AI — Conversational Expense Tracker](https://www.doraai.money/)
- [ExpenseMind: AI Budget Tracker — Google Play](https://play.google.com/store/apps/details?id=ck.trails.ai_expense_logger.expense_mind&hl=en_US)
- [Voicash — Voice AI Expense Tracker](https://mwm.ai/apps/voicash-voice-expense-tracker/6747767199)
- [AI in Personal Finance 2026: Comparing the Top Tools — Origin](https://useorigin.com/resources/blog/ai-in-personal-finance-2026-comparing-the-top-tools-and-approaches)
- [Monefy — Google Play](https://play.google.com/store/apps/details?id=com.monefy.app.lite&hl=en_US)
- [Spendee — Google Play](https://play.google.com/store/apps/details?id=com.cleevio.spendee)
