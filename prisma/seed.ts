// Demo data: three months of plausible spending for one user.
//
// Exists so the charts and budget bars have something to show on a fresh
// clone. Without it the first impression of the app is a lot of empty cards.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

type Template = {
  kind: 'expense' | 'income';
  category: string;
  merchant: string;
  /** Major-unit range; the seeder picks a value inside it. */
  min: number;
  max: number;
  /** Roughly how many times a month this happens. */
  perMonth: number;
};

const TEMPLATES: Template[] = [
  { kind: 'income', category: 'income', merchant: 'Salary', min: 3200, max: 3200, perMonth: 1 },
  { kind: 'expense', category: 'housing', merchant: 'Rent', min: 1150, max: 1150, perMonth: 1 },
  { kind: 'expense', category: 'groceries', merchant: 'Supermarket', min: 22, max: 95, perMonth: 7 },
  { kind: 'expense', category: 'dining', merchant: 'Cafe', min: 3.5, max: 9, perMonth: 12 },
  { kind: 'expense', category: 'dining', merchant: 'Restaurant', min: 18, max: 62, perMonth: 4 },
  { kind: 'expense', category: 'transport', merchant: 'Metro', min: 2.4, max: 2.4, perMonth: 18 },
  { kind: 'expense', category: 'transport', merchant: 'Rideshare', min: 8, max: 26, perMonth: 3 },
  { kind: 'expense', category: 'utilities', merchant: 'Electricity', min: 55, max: 120, perMonth: 1 },
  { kind: 'expense', category: 'subscriptions', merchant: 'Streaming', min: 11, max: 18, perMonth: 3 },
  { kind: 'expense', category: 'shopping', merchant: 'Clothing', min: 25, max: 140, perMonth: 1 },
  { kind: 'expense', category: 'health', merchant: 'Pharmacy', min: 9, max: 48, perMonth: 1 },
  { kind: 'expense', category: 'entertainment', merchant: 'Cinema', min: 12, max: 30, perMonth: 1 },
];

function between(min: number, max: number): number {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

async function main() {
  const currency = process.env.DEFAULT_CURRENCY?.toUpperCase() || 'USD';

  // Seeded as an anonymous account, the same shape a first-time visitor gets.
  // Signing in later merges this ledger onto the real account.
  const user = await prisma.user.create({
    data: {
      label: 'Demo',
      name: 'Demo',
      email: `seed-${Date.now().toString(36)}@anonymous.local`,
      isAnonymous: true,
      currency,
      timezone: process.env.DEFAULT_TIMEZONE || 'UTC',
    },
  });

  const now = new Date();
  const rows: Array<{
    userId: string;
    kind: 'expense' | 'income';
    amountMinor: number;
    currency: string;
    merchant: string;
    category: string;
    occurredAt: Date;
    source: string;
  }> = [];

  // Three months back, including the current partial one.
  for (let monthsAgo = 2; monthsAgo >= 0; monthsAgo--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
    const daysInMonth = new Date(
      monthStart.getFullYear(),
      monthStart.getMonth() + 1,
      0,
    ).getDate();
    // Don't seed the future.
    const lastDay = monthsAgo === 0 ? now.getDate() : daysInMonth;

    for (const template of TEMPLATES) {
      const occurrences = Math.max(
        1,
        Math.round((template.perMonth * lastDay) / daysInMonth),
      );
      for (let i = 0; i < occurrences; i++) {
        const day = 1 + Math.floor(Math.random() * lastDay);
        const occurredAt = new Date(
          monthStart.getFullYear(),
          monthStart.getMonth(),
          day,
          9 + Math.floor(Math.random() * 11),
          Math.floor(Math.random() * 60),
        );
        rows.push({
          userId: user.id,
          kind: template.kind,
          amountMinor: Math.round(between(template.min, template.max) * 100),
          currency,
          merchant: template.merchant,
          category: template.category,
          occurredAt,
          source: 'manual',
        });
      }
    }
  }

  await prisma.transaction.createMany({ data: rows });

  await prisma.budget.createMany({
    data: [
      { userId: user.id, category: 'dining', limitMinor: 20000, currency },
      { userId: user.id, category: 'groceries', limitMinor: 45000, currency },
      { userId: user.id, category: 'transport', limitMinor: 12000, currency },
      { userId: user.id, category: 'shopping', limitMinor: 15000, currency },
    ],
  });

  console.log(`Seeded user ${user.id} with ${rows.length} transactions and 4 budgets.`);
  console.log('Note: the app assigns YOU a fresh anonymous user on first visit.');
  console.log('To see this data, set the pfa_uid cookie for that user, or just log your own.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
