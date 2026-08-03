'use client';

import { useState } from 'react';

import CsvImport from '@/components/import/CsvImport';
import SmsImport from '@/components/import/SmsImport';
import type { AccountOption } from '@/lib/finance/account-types';
import type { CategoryOption } from '@/lib/finance/categories';

// Two ways in, both landing in the same place.
//
// SMS leads because it is the one people can do today, on a phone, with no
// exporting. A statement is more complete but you have to go and fetch it.

const TABS = [
  { id: 'sms', label: 'Bank messages', hint: 'Paste the SMS your bank already sends you' },
  { id: 'csv', label: 'Statement file', hint: 'A CSV exported from online banking' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function ImportTabs({
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
  const [tab, setTab] = useState<TabId>('sms');

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="How to import"
        className="flex rounded-full border border-line bg-surface-2 p-0.5 text-xs"
      >
        {TABS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={tab === option.id}
            title={option.hint}
            onClick={() => setTab(option.id)}
            className={`flex-1 rounded-full px-3 py-1.5 font-medium transition-colors ${
              tab === option.id
                ? 'bg-surface text-ink shadow-raised'
                : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {tab === 'sms' ? (
        <SmsImport currency={currency} today={today} categories={categories} />
      ) : (
        <CsvImport
          currency={currency}
          today={today}
          categories={categories}
          accounts={accounts}
        />
      )}
    </div>
  );
}
