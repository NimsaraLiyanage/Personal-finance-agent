import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tally — personal finance agent',
  description:
    'A conversational finance assistant: log spending by text or voice, and get answers from your own ledger.',
};

export const viewport: Viewport = {
  themeColor: '#f2f4f7',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
